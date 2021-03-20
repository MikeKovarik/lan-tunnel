# lan-tunnel

🖇Library for exposing server from local network to the internet.

## Why

When you need to access your raspberry pi or a automation hub from the internet, but port forwarding or public IP is not an option. 

## How it works

Consists of two parts:
* **Proxy server**
<br>Forwards incoming internet requests through a tunnel to your LAN.
<br>Needs to be run on your own server accessible from the internet, VPS or something like heroku.
* **Client**
<br>Is run from within your LAN.
<br>It serves as a glue between your app and the proxy by opening a pool of keep-alive sockets connection both and passes 
<br>Can be a part of your app or a separate process.

Your app (web server) doesn't need to change. It just responds to its usual port.


## TL;DR

```js
          PROXY SERVER         TUNNEL         LAN APP
 available on internet    exposes the app     inaccessible from internet
 at https://you.com:80   through tunnelPort   at http://localhost:80
                    |                          |
                    |                          | Your app connects to proxy
                    | <----------------------- | and opens keep-alive tunnel
                    |                          | sockets for handling requests
                    |                          |
    GET request     |                          |
you.com/index.html  |   pass request to app    |
------------------> |   localhost/index.html   |
                    | -----------------------> |
                    |                          | Your app serves /index.html
    proxy serves    |   pass /index.html back  |
    /index.html     | <----------------------- |
<------------------ |                          |
                    |                          |
```

## Installation

```
npm install lan-tunnel
```

## Usage

Check out the extended [`example`](example).

Proxy server

```js
import {createProxyServer} from 'lan-tunnel'

createProxyServer({
	// Port where you can access the app from internet
	proxyPort: 80,
	// Internal port for communicating between the proxy and your local app
	tunnelPort: 8010
})
```

Client side

```js
import {connectToProxy} from 'lan-tunnel'

// Include this in your app, or run separately
connectToProxy({
	// The internet proxy server at which the app will be exposed
    tunnelHost: 'your-proxy-server.com',
	tunnelPort: 8010,
	// Your app
	appPort: 8080
})

// your typical web server listening on the appPort.
const app = express()
app.listen(8080)
```

Client code can also run standalone on a different machine if you define `appHost`.

## License

MIT, Mike Kovařík, Mutiny.cz
