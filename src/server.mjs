import net from 'net'
import tls from 'tls'
import http from 'http'
import https from 'https'
import {log, logLevel, INFO, VERBOSE, setLogLevel, removeFromArray, applyOptions, setupLongLivedSocket} from './shared.mjs'
import {verifyReceiverTunnel, createCipher, canEncryptTunnel} from './encryption.mjs'
import defaultOptions from './options.mjs'


const FIRST_CHUNK = Symbol('firstChunk')

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
		// http 'upgrade' is called on websockets. Ensure it's long-lived despite user's timeout setting.
		this.proxy.on('upgrade', (req, socket) => setupLongLivedSocket(socket))
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
		// If 'error' event is unhandled, the app crashes. But we don't need to do anything about it since
		// we're already listening to 'close' event which is fired afterwards.
		const close = () => this.onRequestClosed(request)
		request.once('error', close)
		request.once('end', close)

		if (this.tunnelPool.length)
			this.pipeSockets(request, this.tunnelPool.shift())
		else
			this.requestQueue.push(request)

		request.setTimeout(this.requestTimeout)
	}

	onRequestClosed(request) {
		removeFromArray(this.requestQueue, request)
		request.end()
	}

	onTunnelOpened = tunnel => {
		// If 'error' event is unhandled, the app crashes. But we don't need to do anything about it since
		// we're already listening to 'close' event which is fired afterwards.
		const close = () => this.onTunnelClosed(tunnel)
		tunnel.once('error', close)
		tunnel.once('end', close)

		if (this.secret) {
			this.verifyReceiverTunnel(tunnel, this)
				.then(() => this.acceptTunnel(tunnel))
				.catch(() => tunnel.end())
		} else {
			this.acceptTunnel(tunnel)
		}
	}

	acceptTunnel(tunnel) {
		setupLongLivedSocket(tunnel)
		if (this.tunnelPool.length === 0)
			log(INFO, `App connected (first tunnel connected)`)
		if (this.requestQueue.length)
			this.pipeSockets(this.requestQueue.shift(), tunnel)
		else
			this.tunnelPool.push(tunnel)
	}

	onTunnelClosed(tunnel) {
		removeFromArray(this.tunnelPool, tunnel)
		tunnel.end()
		if (this.tunnelPool.length === 0)
			log(INFO, `App diconnected (all tunnels are closed, tunnel server remains listening)`)
	}

	pipeSockets(request, tunnel) {
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

const logIncomingSocket = (socket, firstChunk) => {
	socket.once('data', buffer => {
		let string = Buffer.concat([firstChunk, buffer]).slice(0, 100).toString()
		let firstLine = string.slice(0, string.indexOf('\n'))
		let httpIndex = firstLine.indexOf(' HTTP/')
		if (httpIndex !== -1)
			log(VERBOSE, 'SERVER:', firstLine.slice(0, httpIndex))
		else
			log(VERBOSE, 'SERVER:', 'UNKNOWN REQUEST', string)
	})
}

export function createProxyServer(options) {
	new ProxyServer(options)
}