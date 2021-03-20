import net from 'net'
import {EventEmitter} from 'events'
import {removeFromArray, applyOptions, createCipher, canEncryptTunnel} from './shared.mjs'


const defaultOptions = {
	// debug logging info to console
	log: false,
	// Ammount of standby open tunnel connections 
	maxTunnels: 20,
	// Time between crashing/disconnecting and attempting to reconnect. In milliseconds.
	reconnectTimeout: 15 * 1000,
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
}

class Tunnel extends EventEmitter {

	remoteConnecting = true
	localConnecting = true
	remoteConnected = false
	localConnected = false

	get connecting() {
		return this.remoteConnecting && this.localConnecting
	}

	get connected() {
		return this.remoteConnected && this.localConnected
	}

	constructor(options) {
		super()
		let {appHost, appPort, tunnelHost, tunnelPort} = options
		this.tunnelEncryption = options.tunnelEncryption

		const remote = this.remote = net.connect({
			host: tunnelHost,
			port: tunnelPort
		})

		const local = this.local = net.connect({
			host: appHost,
			port: appPort
		})

		remote.setKeepAlive(true)
		local.setKeepAlive(true)

		remote.once('connect', () => {
			this.remoteConnecting = false
			this.remoteConnected = true
			if (this.connected) this.emit('connect')
		})
		local.once('connect', () => {
			this.localConnecting = false
			this.localConnected = true
			if (this.connected) this.emit('connect')
		})

		remote.on('error', this.close)
		local.on('error', this.close)
		remote.on('end', this.close)
		local.on('end', this.close)

		this.pipeSockets()
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

	pipeSockets() {
		let {local, remote} = this
		if (canEncryptTunnel(this.tunnelEncryption)) {
			// Encrypted tunnel
			const {cipher, decipher} = createCipher(this.tunnelEncryption)
			remote
				.pipe(decipher) // Decrypt request from tunnel
				.pipe(local)    // Forward the request to be handle by the app
				.pipe(cipher)   // Encrypt response from the app
				.pipe(remote)   // Forward the encrypted response be served by the proxy
		} else {
			// Raw tunnel
			remote
				.pipe(local)  // Forward the request to the app
				.pipe(remote) // Forward response from the app through tunnel back to requester
		}
	}

}

class ProxyServer {

	openTunnels = []

	constructor(options) {
		this.processOptions(options)
		this.tryOpenTunnels()
	}

	processOptions(options) {
		applyOptions(this, defaultOptions, options)
		if (!this.appHost)    throw new Error(`appHost is undefined`)
		if (!this.appPort)    throw new Error(`appPort is undefined`)
		if (!this.tunnelHost) throw new Error(`tunnelHost is undefined`)
		if (!this.tunnelPort) throw new Error(`tunnelPort is undefined`)
	}

	tryOpenTunnels = async () => {
		if (this.log) console.log('Trying to open tunnels')
		let firstTunnel = this.createTunnel()
		try {
			await firstTunnel.getPromise()
			if (this.log) console.log('First tunnel opened successfully')
			// Sucessfully connected to both local and remote servers, go ahead creating all other tunnels.
			this.fillTunnels()
		} catch(err) {
			// Failed to connect. Either remote or local is probably down. Retry later.
			if (this.log) console.log('Unable to open tunnels')
			// NOTE: scheduling retry is handled by 'end' handler.
		}
	}

	scheduleReconnect() {
		clearTimeout(this.timeout)
		this.timeout = setTimeout(this.tryOpenTunnels, this.reconnectTimeout)
	}

	fillTunnels = () => {
		while (this.openTunnels.length < this.maxTunnels)
			this.createTunnel()
	}

	createTunnel() {
		let tunnel = new Tunnel(this)
		this.openTunnels.push(tunnel)
		tunnel.once('end', () => {
			// Cleanup once the tunnel closes
			removeFromArray(this.openTunnels, tunnel)
			if (this.openTunnels.length === 0) {
				// This was the last/only tunnel. We're likely in the boot phase where one failed
				// tunnel means something is wrong and there's no reason to retry right away.
				if (this.log) console.log('All tunnels are down')
				this.scheduleReconnect()
			} else {
				// This was not the only tunnel. Probably closed after fulfilling request.
				this.fillTunnels()
			}
		})
		return tunnel
	}

}

export function connectToProxy(options) {
	new ProxyServer(options)
}