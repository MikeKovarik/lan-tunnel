export default {

	// SERVER ONLY
	// External port, at which the app is exposed.
	proxyPort: 80,

	// CLIENT ONLY
	// IP/hostname of the proxy where the app will be exposed.
	tunnelHost: undefined,
	// rename to proxyHost ??

	// CLIENT & SERVER
	// Internal port, opened on the proxy server, used to receive connections from the app within hidden network.
	tunnelPort: undefined,

	// CLIENT ONLY
	// IP/hostname at which the app runs. Will be forwared to the proxy.
	// Usually localhost, but this module can be run outside the app and bridge other IP too.
	appHost: 'localhost',

	// CLIENT ONLY
	// Port at which the app runs. This port will be forwared to the proxy.
	appPort: 80,

	// --------------------- SSL/HTTP ENCRYPTION --------------------

	// SERVER ONLY
	// Certificate for proxy server encryption. I.e. makes the exposed app HTTPS instead of HTTP (SSL instead of TCP).
	// See 'key' and 'cert' properties of https://nodejs.org/api/tls.html#tls_tls_createsecurecontext_options.
	key: undefined,
	cert: undefined,

	// CLIENT & SERVER
	// Cipher used to encrypt tunnel connections (they're basic TCP sockets, but can be encrypted).
	// key and iv are required to turn on encryption. More info: https://nodejs.org/api/crypto.html#crypto_crypto_createcipheriv_algorithm_key_iv_options.
	tunnelEncryption: {
		key: undefined,
		iv: undefined,
		cipher: 'aes-256-ctr',
	},

	// --------------------- TUNNEL INITIALIZATION CHALLENGE --------------------

	// CLIENT & SERVER
	secret: undefined,
	challengeTimeout: 4000,

	// --------------------- SOCKETS --------------------

	// SERVER ONLY
	// Sets the socket to timeout after timeout milliseconds of inactivity on the socket. By default net.Socket do not have a timeout.
	// calls socket.setTimeout() https://nodejs.org/api/net.html#socketsettimeouttimeout-callback
	requestTimeout: 5000,

	// CLIENT ONLY
	// Ammount of standby open tunnel connections 
	tunnelSocketsPoolSize: 20,

	// CLIENT ONLY
	// Time between crashing/disconnecting and attempting to reconnect. In milliseconds.
	reconnectTimeout: 5 * 1000,

}