import net from 'net'
import {EventEmitter} from 'events'
import {removeFromArray, applyOptions, createCipher, canEncryptTunnel} from './shared.mjs'
import {log, logLevel, setLogLevel, INFO, VERBOSE} from './shared.mjs'


const defaultOptions = {
	// Ammount of standby open tunnel connections 
	maxTunnels: 20,
	// Time between crashing/disconnecting and attempting to reconnect. In milliseconds.
	reconnectTimeout: 5 * 1000,
	// IP address of the proxy where the app will be exposed.
	tunnelHost: undefined,
	// Port at the proxy where the app will be exposed.
	tunnelPort: undefined,
	// IP address of the app. It's usually localhost, but this module can be run outside the app and bridge other IP too.
	appHost: 'localhost',
	// Port at which the app runs. This port will be forwared to the proxy.
	appPort: 80,
	// Cipher used to encrypt tunnel connections (they're basic TCP sockets, but can be encrypted).
	// key and iv are required to turn on encryption. More info: https://nodejs.org/api/crypto.html#crypto_crypto_createcipheriv_algorithm_key_iv_options.
	tunnelEncryption: {
		key: undefined,
		iv: undefined,
		cipher: 'aes-256-ctr',
	},
	// challenge
	secret: undefined,
	challengeTimeout: 4000,
}

class Tunnel extends EventEmitter {

	remoteConnecting = true
	localConnecting = true
	remoteConnected = false
	localConnected = false
	verified = false

	get connecting() {
		return this.remoteConnecting && this.localConnecting
	}

	get connected() {
		return this.remoteConnected
			&& this.localConnected
			&& this.verified
	}

	constructor(options) {
		super()

		this.secret           = options.secret
		this.tunnelEncryption = options.tunnelEncryption
		this.challengeTimeout = options.challengeTimeout

		let {appHost, appPort, tunnelHost, tunnelPort} = options

		const remote = this.remote = net.connect({
			host: tunnelHost,
			port: tunnelPort
		})

		const local = this.local = net.connect({
			host: appHost,
			port: appPort
		})

		setupRequestSocket(remote)
		setupRequestSocket(local)

		remote.once('connect', () => {
			this.remoteConnecting = false
			this.remoteConnected = true
			if (this.secret) {
				this.verifyTunnel()
					.then(this.tryEmitConnect)
					.catch(this.close)
			} else {
				this.verified = true
				this.tryEmitConnect()
			}
		})

		local.once('connect', () => {
			this.localConnecting = false
			this.localConnected = true
			this.tryEmitConnect()
		})

		remote.on('error', this.close)
		local.on('error', this.close)
		remote.on('end', this.close)
		local.on('end', this.close)

		// connect the two sockets once both are connected (and remote is verified with secret).
		this.on('connect', this.pipeSockets)
	}

	tryEmitConnect = () => {
		if (this.connected) this.emit('connect')
	}

	verifyTunnel() {
		return new Promise((resolve, reject) => {
			let timeout
			this.remote.write(this.secret)
			const onReadable = () => {
				clearTimeout(timeout)
				let [accepted] = this.remote.read(1)
				this.verified = accepted === 1
				if (this.verified)
					resolve()
				else
					reject()
				this.remote.removeListener('readable', onReadable)
			}
			timeout = setTimeout(() => {
				this.remote.removeListener('readable', onReadable)
				log(INFO, 'challenge timed out, closing tunnel')
				reject()
			}, this.challengeTimeout)
			this.remote.on('readable', onReadable)
		})
	}

	getPromise() {
		return new Promise((resolve, reject) => {
			this.once('connect', resolve)
			this.once('end', reject)
		})
	}

	close = () => {
		this.local.end()
		this.remote.end()
		this.remoteConnected = false
		this.localConnected = false
		this.emit('end')
	}

	pipeSockets = () => {
		let {local, remote} = this
		if (logLevel === VERBOSE)
			logIncomingSocket(remote)
		if (canEncryptTunnel(this.tunnelEncryption)) {
			// Encrypted tunnel
			const {cipher, decipher} = createCipher(this.tunnelEncryption)
			//if (logLevel === VERBOSE)
			//	logIncomingSocket(decipher)
			remote
				.pipe(decipher) // Decrypt remote request from tunnel
				.pipe(local)    // Forward the request to be handled by the app
				.pipe(cipher)   // Encrypt response from the app
				.pipe(remote)   // Forward the encrypted response be served by the proxy
		} else {
			// Raw tunnel
			//if (logLevel === VERBOSE)
			//	logIncomingSocket(remote)
			remote
				.pipe(local)  // Forward the request to the app
				.pipe(remote) // Forward response from the app through tunnel back to requester
		}
	}

}

const SOCKID = Symbol()

const getId = socket => socket[SOCKID] = socket[SOCKID] ?? Math.round(Math.random() * 100)

const logIncomingSocket = socket => {
	const id = getId(socket)
	socket.once('data', buffer => {
		let string = buffer.slice(0, 100).toString()
		let firstLine = string.slice(0, string.indexOf('\n'))
		let httpIndex = firstLine.indexOf(' HTTP/')
		if (httpIndex !== -1)
			log(VERBOSE, 'CLIENT:', id.toString(), firstLine.slice(0, httpIndex))
		else
			log(VERBOSE, 'CLIENT:', id.toString(), 'UNKNOWN REQUEST', string)
	})
	socket.once('end', () => {
		log(VERBOSE, 'CLIENT:', id.toString(), 'end')
	})
}



class ProxyClient {

	openTunnels = []

	constructor(options) {
		this.processOptions(options)
		this.tryOpenTunnels()
	}

	processOptions(options) {
		setLogLevel(options.log)
		applyOptions(this, defaultOptions, options)
		if (!this.appHost)    throw new Error(`appHost is undefined`)
		if (!this.appPort)    throw new Error(`appPort is undefined`)
		if (!this.tunnelHost) throw new Error(`tunnelHost is undefined`)
		if (!this.tunnelPort) throw new Error(`tunnelPort is undefined`)
	}

	tryOpenTunnels = async () => {
		log(INFO, 'Trying to open tunnels')
		let firstTunnel = this.createTunnel()
		let localFailCb = () => console.error('Failed to connect tunnel to local (app)')
		let remoteFailCb = () => console.error('Failed to connect tunnel to remote (proxy)')
		firstTunnel.local.on('error', localFailCb)
		firstTunnel.remote.on('error', remoteFailCb)
		try {
			await firstTunnel.getPromise()
			log(INFO, 'First tunnel opened successfully')
			// Sucessfully connected to both local and remote servers, go ahead creating all other tunnels.
			this.fillTunnels()
		} catch(err) {
			// Failed to connect. Either remote or local is probably down. Retry later.
			log(INFO, 'Unable to open tunnels')
			log(VERBOSE, 'error', err)
			// NOTE: scheduling retry is handled by 'end' handler.
		}
		firstTunnel.local.removeListener('error', localFailCb)
		firstTunnel.remote.removeListener('error', remoteFailCb)
	}

	scheduleReconnect() {
		clearTimeout(this.timeout)
		this.timeout = setTimeout(this.tryOpenTunnels, this.reconnectTimeout)
	}

	fillTunnelsTimeout = undefined
	onTunnelEnd() {
		if (this.fillTunnelsTimeout === undefined)
			this.fillTunnelsTimeout = setTimeout(this.onTunnelEndDebounced, 300)
	}

	onTunnelEndDebounced = () => {
		this.fillTunnelsTimeout = undefined
		if (this.openTunnels.length === 0) {
			// This was the last/only tunnel. We're likely in the boot phase where one failed
			// tunnel means something is wrong and there's no reason to retry right away.
			log(INFO, 'All tunnels are down')
			this.scheduleReconnect()
		} else {
			// This was not the only tunnel. Probably closed after fulfilling request.
			this.fillTunnels()
		}
	}

	fillTunnels = () => {
		if (this.openTunnels.length < this.maxTunnels) {
			log(VERBOSE, `Filling empty spots after closing tunnels. ${this.openTunnels.length} / ${this.maxTunnels}`)
			while (this.openTunnels.length < this.maxTunnels)
				this.createTunnel()
		}
	}

	createTunnel() {
		let tunnel = new Tunnel(this)
		this.openTunnels.push(tunnel)
		tunnel.once('end', () => {
			// Cleanup once the tunnel closes
			removeFromArray(this.openTunnels, tunnel)
			this.onTunnelEnd()
		})
		return tunnel
	}

}

export function exposeThroughProxy(options) {
	new ProxyClient(options)
}

function setupRequestSocket(socket) {
	socket.setTimeout(0)
	socket.setNoDelay(true)
	socket.setKeepAlive(true, 0)
}
