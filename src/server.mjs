import net from 'net'
import tls from 'tls'
import http from 'http'
import https from 'https'
import {removeFromArray, applyOptions, createCipher, canEncryptTunnel} from './shared.mjs'
import {log, logLevel, INFO, VERBOSE, setLogLevel} from './shared.mjs'


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

const FIRST_CHUNK = Symbol()

class ProxyServer {

	tunnelPool = []
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
		let useHttp = true
		if (cert && key) {
			this.proxy = useHttp
				? https.createServer({cert, key})
				: tls.createServer({cert, key})
			serverType = 'HTTPS/SSL'
		} else {
			this.proxy = useHttp
				? http.createServer()
				: net.createServer()
			serverType = 'HTTP/TCP'
		}
		// HTTP/WEBSOCKET related: It's important to to let Nodejs do some internal steps after 'connection' event
		// rather than listening to 'requst' event directly.
		// This doesn't apply to basic TCP connection where there's only 'connection'.
		if (logLevel >= INFO) this.proxy.on('listening', () => console.log(`${serverType} Proxy server is listening on port ${proxyPort}`))
		this.proxy.on('connection', useHttp ? this.onHttpServerConnection : this.onProxyRequest)
		this.proxy.on('upgrade', (req, socket) => console.log('upgrade', getId(socket)))
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

	restartProxyServer = () => {
		log(INFO, `Restarting proxy server`)
		this.proxy.close(this.startProxyServer)
	}

	restartTunnelServer = () => {
		log(INFO, `Restarting tunnel server`)
		this.tunnel.close(this.startTunnelServer)
	}

	onHttpServerConnection = socket => {
		// IMPORTANT: it's important to wait for the first data event.
		// CONNECTION CANNOT BE ESTABLISHED IMMEDIATELY!
		// Nodejs first does some internal header parsing and then determines wheter
		// to fire 'request' or 'upgrade' event. Upgrade is needed for websockets!
		// It only works this way!
		socket.once('data', firstChunk => {
			socket[FIRST_CHUNK] = firstChunk
			this.onProxyRequest(socket)
		})
	}

	onProxyRequest = request => {
		setupRequestSocket(request)
		// If 'error' event is unhandled, the app crashes. But we don't need to do anything about it since
		// we're already listening to 'close' event which is fired afterwards.
		request.on('error', () => {})
		request.on('close', () => this.destroyRequest(request))
		if (this.tunnelPool.length)
			this.pipeSockets(request, this.tunnelPool.shift())
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
		setupRequestSocket(tunnel)
		//tunnel.setKeepAlive(true, 2000)
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
		if (this.tunnelPool.length === 0)
			log(INFO, `App connected (first tunnel connected)`)
		if (this.requestQueue.length)
			this.pipeSockets(this.requestQueue.shift(), tunnel)
		else
			this.tunnelPool.push(tunnel)
	}

	onTunnelClosed(tunnel) {
		removeFromArray(this.tunnelPool, tunnel)
		if (this.tunnelPool.length === 0)
			log(INFO, `App diconnected (all tunnels are closed, tunnel server remains listening)`)
	}

	pipeSockets(request, tunnel) {
		const id = getId(request)
		const firstChunk = request[FIRST_CHUNK]
		if (logLevel === VERBOSE)
			logIncomingSocket(request, firstChunk)
		if (this.encryptTunnel) {
			// Encrypted tunnel
			const {cipher, decipher} = createCipher(this.tunnelEncryption)
			if (firstChunk) cipher.write(firstChunk)
			request
				.pipe(cipher)   // Encrypt the request
				.pipe(tunnel)   // Forward encrypted request through tunnel to client
				.pipe(decipher) // Decrypt received response from client
				.pipe(request)  // Forward the response back to requester
		} else {
			// Raw tunnel
			if (firstChunk) tunnel.write(firstChunk)
			request
				.pipe(tunnel)  // Forward the request through tunnel to client
				.pipe(request) // Forward response from client through tunnel back to requester
		}
	}

}

function setupRequestSocket(socket) {
	socket.setTimeout(0)
	socket.setNoDelay(true)
	socket.setKeepAlive(true, 0)
}

const SOCKID = Symbol()

const getId = socket => socket[SOCKID] = socket[SOCKID] ?? Math.round(Math.random() * 100)

const logIncomingSocket = (socket, firstChunk) => {
	const id = getId(socket)
	socket.once('data', buffer => {
		let string = Buffer.concat([firstChunk, buffer]).slice(0, 100).toString()
		let firstLine = string.slice(0, string.indexOf('\n'))
		let httpIndex = firstLine.indexOf(' HTTP/')
		if (httpIndex !== -1)
			log(VERBOSE, 'SERVER:', id.toString(), firstLine.slice(0, httpIndex))
		else
			log(VERBOSE, 'SERVER:', id.toString(), 'UNKNOWN REQUEST', string)
	})
}

export function createProxyServer(options) {
	new ProxyServer(options)
}