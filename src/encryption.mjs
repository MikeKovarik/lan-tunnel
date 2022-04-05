import crypto from 'crypto'
import {log, logSocket, logLevel, INFO, VERBOSE, setLogLevel} from './shared.mjs'


export function createCipher({cipher, key, iv}) {
	return {
		cipher: crypto.createCipheriv(cipher, key, iv),
		decipher: crypto.createDecipheriv(cipher, key, iv),
	}
}

export function canEncryptTunnel({cipher, key, iv}) {
	return !!cipher && !!key && !!iv
}

export const CHALLENGE = {
	EMPTY:     0,
	VERIFIED:  1,
	INCORRECT: 2,
}

export function verifyReceiverTunnel(socket, {secret, challengeTimeout}) {
	return new Promise((resolve, reject) => {
		socket.setTimeout(challengeTimeout)
		const onReadable = () => {
			socket.removeListener('readable', onReadable)
			socket.removeListener('timeout', onTimeout)
			let challenge = socket.read(secret.length)
			// may be undefined
			if (!challenge) {
				log(INFO, `Tunnel rejected: no secret`)
				socket.write(Buffer.from([CHALLENGE.EMPTY]), reject)
			} else if (challenge.toString() !== secret) {
				log(INFO, `Tunnel rejected: incorrect secret`)
				socket.write(Buffer.from([CHALLENGE.INCORRECT]), reject)
			} else {
				logSocket(socket, `Tunnel verified`)
				socket.write(Buffer.from([CHALLENGE.VERIFIED]), resolve)
			}
		}
		const onTimeout = () => {
			socket.removeListener('readable', onReadable)
			socket.removeListener('timeout', onTimeout)
			log(INFO, 'challenge timed out, closing tunnel')
			reject()
		}
		socket.once('readable', onReadable)
		socket.once('timeout', onTimeout)
	})
}

export function verifySenderTunnel(socket, {secret, challengeTimeout}) {
	return new Promise((resolve, reject) => {
		socket.setTimeout(challengeTimeout)
		socket.write(secret)
		const onReadable = () => {
			socket.removeListener('readable', onReadable)
			socket.removeListener('timeout', onTimeout)
			let [accepted] = socket.read(1)
			if (accepted === CHALLENGE.VERIFIED)
				resolve()
			else
				reject()
		}
		const onTimeout = () => {
			socket.removeListener('readable', onReadable)
			socket.removeListener('timeout', onTimeout)
			log(INFO, 'challenge timed out, closing tunnel')
			reject()
		}
		socket.once('readable', onReadable)
		socket.once('timeout', onTimeout)
	})
}
