// Run this code on your server.
import fs from 'fs'
import {createProxyServer} from '../index.mjs' // 'lan-tunnel


createProxyServer({
	// Online port where you can access the app from internet.
	proxyPort:  1610,
	// Port used by the library to communicate between this proxy server and your local app.
	tunnelPort: 8010,
	// OPTIONAL: Certificate to make the server HTTPS instead of simple HTTP.
	key:  fs.readFileSync('../../ssl.key'),
	cert: fs.readFileSync('../../ssl.cert'),
	// OPTIONAL: Encryption of TCP tunnels
	tunnelEncryption: {
		key: 'abcdefghijklmnopqrstuvwxyzABCDEF',
		iv: '1234567890123456',
		//cipher: 'aes-256-ctr', // default
	},
})