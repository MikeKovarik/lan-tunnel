const http = require('http')
const net = require('net')


const config = {
	proxyPort:  8123,
	appPort:    8123,
	appHost:    'jarvis-hub.lan',
}

const proxServer = http.createServer()

proxServer.on('connection', socket => {
	// IMPORTANT: it's important to wait for the first data event.
	// CONNECTION CANNOT BE ESTABLISHED IMMEDIATELY!
	// Nodejs first does some internal header parsing and then determines wheter
	// to fire 'request' or 'upgrade' event. Upgrade is needed for websockets!
	// It only works this way!
	socket.once('data', buffer => {
		const local = net.connect({
			host: config.appHost,
			port: config.appPort,
		})
		setupSocket(socket)
		setupSocket(local)
		socket.on('error', () => local.end())
		local.write(buffer)
		socket.pipe(local).pipe(socket)
	})

})

function setupSocket(socket) {
	socket.setTimeout(0)
	socket.setNoDelay(true)
	socket.setKeepAlive(true, 0)
}

proxServer.listen(config.proxyPort, () => {
	console.log(`dummy proxy running at http://localhost:${config.proxyPort}/`)
})
