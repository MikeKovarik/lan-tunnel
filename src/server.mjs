import net from 'net'
import tls from 'tls'
import {removeFromArray, applyOptions, createCipher, canEncryptTunnel} from './shared.mjs'
import {log, logLevel, INFO, VERBOSE} from './shared.mjs'


const defaultOptions = {
	// Internal port used opened on the proxy server, used to receive connections from the app within hidden network.
	tunnelPort: undefined,
	// External port, at which the app is exposed.
	proxyPort: 80,
	// Certificate for proxy server encryption. I.e. makes the exposed app HTTPS instead of HTTP (SSL instead of TCP).
	// See 'key' and 'cert' properties of https://nodejs.org/api/tls.html#tls_tls_createsecurecontext_options.
	key: undefined,
	cert: undefined,
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

class ProxyServer {

	openTunnels = []
	requestQueue = []

	constructor(options) {
		this.processOptions(options)
		this.startProxyServer()
		this.startTunnelServer()
	}

	processOptions(options) {
		setLogLevel(options.log)
		applyOptions(this, defaultOptions, options)
		if (typeof this.proxyPort !== 'number') throw new Error(`proxyPort not defined`)
		if (typeof this.tunnelPort !== 'number') throw new Error(`tunnelPort not defined`)
		if (this.proxyPort === this.tunnelPort) throw new Error(`proxyPort cannot be the same as tunnelPort`)
		if (typeof this.timeout !== 'number') this.timeout = 5000
		this.encryptTunnel = canEncryptTunnel(this.tunnelEncryption)
	}

	startProxyServer = () => {
		let {proxyPort, cert, key} = this
		let serverType
		if (cert && key) {
			this.proxy = tls.createServer({cert, key}, this.onProxyRequest)
			serverType = 'HTTPS/SSL'
		} else {
			this.proxy = net.createServer(this.onProxyRequest)
			serverType = 'HTTP/TCP'
		}
		if (logLevel >= INFO) this.proxy.on('listening', () => console.log(`${serverType} Proxy server is listening on port ${proxyPort}`))
		this.proxy.on('error', this.restartProxyServer)
		this.proxy.on('close', this.restartProxyServer)
		this.proxy.listen(proxyPort)
	}

	startTunnelServer = () => {
		let {tunnelPort} = this
		let tunnel = this.tunnel = net.createServer(this.onTunnelOpened)
		if (logLevel >= INFO) {
			let message = [
				`HTTP/TCP Tunnel server`,
				this.encryptTunnel && 'with custom encryption',
				`is listening on port ${tunnelPort}`,
			].filter(a => a).join(' ')
			tunnel.on('listening', () => log(INFO, message))
		}
		tunnel.on('error', this.restartTunnelServer)
		tunnel.on('close', this.restartTunnelServer)
		tunnel.listen(tunnelPort)
	}

	restartProxyServer() {
		log(INFO, `Restarting proxy server`)
		this.proxy.close(this.startProxyServer)
	}

	restartTunnelServer() {
		log(INFO, `Restarting tunnel server`)
		this.tunnel.close(this.startTunnelServer)
	}

	onProxyRequest = request => {
		request.setKeepAlive(true)
		// If 'error' event is unhandled, the app crashes. But we don't need to do anything about it since
		// we're already listening to 'close' event which is fired afterwards.
		request.on('error', () => {})
		request.on('close', () => this.destroyRequest(request))
		if (this.openTunnels.length)
			this.pipeSockets(request, this.openTunnels.shift())
		else
			this.requestQueue.push(request)
		this.timeoutRequest(request)
	}

	timeoutRequest(request) {
		setTimeout(() => this.destroyRequest(request), this.timeout)
	}

	destroyRequest(request) {
		removeFromArray(this.requestQueue, request)
		request.end()
	}

	onTunnelOpened = tunnel => {
		tunnel.setKeepAlive(true, 2000)
		// If 'error' event is unhandled, the app crashes. But we don't need to do anything about it since
		// we're already listening to 'close' event which is fired afterwards.
		tunnel.on('error', () => {})
		tunnel.once('close', () => this.onTunnelClosed(tunnel))
		if (this.secret) {
			this.verifyTunnel(tunnel)
				.then(() => this.acceptTunnel(tunnel))
				.catch(() => tunnel.end())
		} else {
			this.acceptTunnel(tunnel)
		}
	}

	verifyTunnel(tunnel) {
		return new Promise((resolve, reject) => {
			let timeout
			const onReadable = () => {
				clearTimeout(timeout)
				let challenge = tunnel.read(this.secret.length)
				// may be undefined
				if (!challenge) {
					log(INFO, `Tunnel rejected: no secret`)
					tunnel.write(Buffer.from([0]), reject)
				} else if (challenge.toString() !== this.secret) {
					log(INFO, `Tunnel rejected: incorrect secret`)
					tunnel.write(Buffer.from([0]), reject)
				} else {
					tunnel.write(Buffer.from([1]), resolve)
				}
				tunnel.removeListener('readable', onReadable)
			}
			timeout = setTimeout(() => {
				tunnel.removeListener('readable', onReadable)
				log(INFO, 'challenge timed out, closing tunnel')
				reject()
			}, this.challengeTimeout)
			tunnel.on('readable', onReadable)
		})
	}

	acceptTunnel(tunnel) {
		if (this.openTunnels.length === 0)
			log(INFO, `App connected (first tunnel connected)`)
		if (this.requestQueue.length)
			this.pipeSockets(this.requestQueue.shift(), tunnel)
		else
			this.openTunnels.push(tunnel)
	}

	rejectTunnel(tunnel) {
		log(INFO, `Tunnel rejected: incorrect secret`)
		tunnel.end()
	}

	onTunnelClosed(tunnel) {
		removeFromArray(this.openTunnels, tunnel)
		if (this.openTunnels.length === 0)
			log(INFO, `App diconnected (all tunnels are closed, tunnel server remains listening)`)
	}

	pipeSockets(request, tunnel) {
		if (this.log === VERBOSE) {
			request.on('data', data => {
				let str = data.toString()
				let firstLine = str.slice(0, str.indexOf('\n'))
				let httpIndex = firstLine.indexOf(' HTTP/')
				if (httpIndex !== -1) log(VERBOSE, firstLine.slice(0, httpIndex))
			})
		}
		if (this.encryptTunnel) {
			// Encrypted tunnel
			const {cipher, decipher} = createCipher(this.tunnelEncryption)
			request
				.pipe(cipher)   // Encrypt the request
				.pipe(tunnel)   // Forward encrypted request through tunnel to client
				.pipe(decipher) // Decrypt received response from client
				.pipe(request)  // Forward the response back to requester
		} else {
			// Raw tunnel
			request
				.pipe(tunnel)  // Forward the request through tunnel to client
				.pipe(request) // Forward response from client through tunnel back to requester
		}
	}

}

export function createProxyServer(options) {
	new ProxyServer(options)
}