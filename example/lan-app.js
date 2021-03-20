// This is the app (running on LAN) you want to expose to the internet.
import express from 'express'
import {connectToProxy} from '../index.js' // 'lan-tunnel


const appPort = 1609

// Enable tunneling data from this app through the internet proxy server.
connectToProxy({
	tunnelHost: 'localhost',
	tunnelPort: 8010,
	// Port at which your HTTP server runs.
	appPort,
	// OPTIONAL: Encryption of TCP tunnels
	tunnelEncryption: {
		key: 'abcdefghijklmnopqrstuvwxyzABCDEF',
		iv: '1234567890123456',
		//cipher: 'aes-256-ctr', // this is the default
	}
})

// Simple HTTP web server for example. But it works with any other protocol on top of TCP.
const app = express()

// serve files from folder
app.use(express.static('lan-app-static'))

// serve dynamic json data
app.get('/devices', (req, res) => {
	let devices = [{
		id: 'stringlight',
		state: {
			on: true,
			uptime: Math.round(Math.random() * 100000)
		}
	}, {
		id: 'growlight',
		state: {
			rgb: 0xFF00FF,
			on: false,
			uptime: Math.round(Math.random() * 100000)
		}
	}]
	let json = JSON.stringify(devices)
	let bytes = Buffer.byteLength(json)
	res.header('Content-Length', bytes)
	res.json(devices)
})

// Run the app at http://localhost:1609
app.listen(appPort)
