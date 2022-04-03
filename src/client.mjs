import net from 'net'
import {EventEmitter} from 'events'
import {log, logLevel, setLogLevel, INFO, VERBOSE, removeFromArray, applyOptions, setupLongLivedSocket} from './shared.mjs'
import {verifySenderTunnel, createCipher, canEncryptTunnel} from './encryption.mjs'
import defaultOptions from './options.mjs'


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

		remote.once('connect', () => {
			this.remoteConnecting = false
			this.remoteConnected = true
			if (this.secret) {
				this.verifySenderTunnel(this.remote, this)
					.then(this.acceptTunnel)
					.catch(this.close)
			} else {
				this.acceptTunnel()
			}
		})

		local.once('connect', () => {
			this.localConnecting = false
			this.localConnected = true
			this.tryEmitConnect()
		})

		remote.once('error', this.close)
		remote.once('end',   this.close)
		local.once('error',  this.close)
		local.once('end',    this.close)

		// connect the two sockets once both are connected (and remote is verified with secret).
		this.on('connect', this.pipeSockets)
	}

	tryEmitConnect = () => {
		if (this.connected) this.emit('connect')
	}

	acceptTunnel = () => {
		this.verified = true
		setupLongLivedSocket(this.remote)
		setupLongLivedSocket(this.local)
		this.tryEmitConnect()
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

const logIncomingSocket = socket => {
	socket.once('data', buffer => {
		let string = buffer.slice(0, 100).toString()
		let firstLine = string.slice(0, string.indexOf('\n'))
		let httpIndex = firstLine.indexOf(' HTTP/')
		if (httpIndex !== -1)
			log(VERBOSE, 'CLIENT:', firstLine.slice(0, httpIndex))
		else
			log(VERBOSE, 'CLIENT:', 'UNKNOWN REQUEST', string)
	})
	socket.once('end', () => {
		log(VERBOSE, 'CLIENT:', 'end')
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
		if (this.openTunnels.length < this.tunnelSocketsPoolSize) {
			log(VERBOSE, `Filling empty spots after closing tunnels. ${this.openTunnels.length} / ${this.tunnelSocketsPoolSize}`)
			while (this.openTunnels.length < this.tunnelSocketsPoolSize)
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
