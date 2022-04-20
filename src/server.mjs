import net from 'net'
import tls from 'tls'
import {log, logLevel, INFO, VERBOSE, DEBUG, setLogLevel, removeFromArray, applyOptions, setupLongLivedSocket, killSocket, mutuallyAssuredSocketDestruction, logSocket, TYPE, getDebugId} from './shared.mjs'
import {verifyReceiverTunnel, createCipher, canEncryptTunnel} from './encryption.mjs'
import defaultOptions from './options.mjs'


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

	restartProxyServer = () => {
		log(INFO, `Restarting proxy server`)
		this.proxy.close(this.startProxyServer)
	}

	restartTunnelServer = () => {
		log(INFO, `Restarting tunnel server`)
		this.tunnel.close(this.startTunnelServer)
	}

	onProxyRequest = request => {
		request[TYPE] = 'request'
		logSocket(request, `incomming request`)

		// If 'error' event is unhandled, the app crashes. But we don't need to do anything about it since
		// we're already listening to 'close' event which is fired afterwards.
		request.once('error',   this.onRequestClosed)
		request.once('end',     this.onRequestClosed)
		request.once('timeout', this.onRequestClosed)
		request.once('close',   this.onRequestClosed)

		// logging after all corresponding hnadlers to have updated queue number in the logs.
		logSocketAll(request, this)

		if (this.tunnelPool.length)
			this.pipeSockets(request, this.tunnelPool.shift())
		else
			this.requestQueue.push(request)

		if (this.requestTimeout !== undefined && request.timeout === undefined)
			request.setTimeout(this.requestTimeout)
	}

	onTunnelOpened = tunnel => {
		tunnel[TYPE] = 'tunnel'
		logSocket(tunnel, `tunnel opened`)

		// If 'error' event is unhandled, the app crashes. But we don't need to do anything about it since
		// we're already listening to 'close' event which is fired afterwards.
		tunnel.once('error',   this.onTunnelClosed)
		tunnel.once('end',     this.onTunnelClosed)
		tunnel.once('timeout', this.onTunnelClosed)
		tunnel.once('close',   this.onTunnelClosed)

		// logging after all corresponding hnadlers to have updated queue number in the logs.
		logSocketAll(tunnel, this)

		try {
			if (this.secret)
				await verifyReceiverTunnel(tunnel, this)
			await this.acceptTunnel(tunnel)
		} catch(err) {
			console.error(`Couldn't open tunnel:`, err)
			tunnel.end()
		}
	}

	acceptTunnel(tunnel) {
		logSocket(tunnel, 'accepted | tunnelPool:', this.tunnelPool.length + 1, 'requestQueue:', this.requestQueue.length)

		setupLongLivedSocket(tunnel)
		if (this.tunnelPool.length === 0)
			log(INFO, `App connected (first tunnel connected)`)

		if (this.requestQueue.length) {
			logSocket(tunnel, 'serving req queue')
			this.pipeSockets(this.requestQueue.shift(), tunnel)
		} else {
			logSocket(tunnel, 'added to pool')
			this.tunnelPool.push(tunnel)
		}
	}

	onRequestClosed = request => {
		killSocket(request)
		removeFromArray(this.requestQueue, request)
	}

	onTunnelClosed = tunnel => {
		killSocket(tunnel)
		const prevLength = this.tunnelPool.length // prevents spamming the "all tunnels ..." message
		removeFromArray(this.tunnelPool, tunnel)
		if (this.tunnelPool.length === 0 && prevLength > 0)
			log(INFO, `App diconnected (all tunnels are closed, tunnel server remains listening)`)
	}

	pipeSockets(request, tunnel) {
		mutuallyAssuredSocketDestruction(request, tunnel)

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

const logSocketAll = (socket, {tunnelPool, requestQueue}) => {
	if (logLevel >= DEBUG) {
		socket.once('error',  err => logSocket(socket, '#error:', err))
		socket.once('end',     () => logSocket(socket, '#end'))
		socket.once('timeout', () => logSocket(socket, '#timeout'))
		socket.once('close',   () => logSocket(socket, '#close'))
		socket.on('data', buffer => {
			let firstLine = buffer.slice(0, 50).toString().split('\n')[0]
			logSocket(socket, '#data:', firstLine)
		})
	} else if (logLevel >= VERBOSE) {
		const socketId = getDebugId(socket)
		const getSocketInfo = () => `${socketId} (${tunnelPool.length.toString()} ${requestQueue.length.toString()})`
		Promise.race([
			promiseEvent(socket, 'error'),
			promiseEvent(socket, 'end'),
			promiseEvent(socket, 'timeout'),
			promiseEvent(socket, 'close'),
		]).then(() => {
			log(VERBOSE, getSocketInfo(), 'closing', socket[TYPE])
		})
		if (socket[TYPE] === 'request') {
			socket.once('data', buffer => {
				let string = buffer.slice(0, 200).toString()
				let firstLine = string.slice(0, string.indexOf('\n'))
				let httpIndex = firstLine.indexOf(' HTTP/')
				if (httpIndex !== -1)
					log(VERBOSE, getSocketInfo(), firstLine.slice(0, Math.min(60, httpIndex)))
				else
					log(VERBOSE, getSocketInfo(), 'UNKNOWN REQUEST', string)
			})
		}
	}
}

export function createProxyServer(options) {
	new ProxyServer(options)
}

const promiseEvent = (target, event) => new Promise(resolve => target.once(event, resolve))