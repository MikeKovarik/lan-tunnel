import crypto from 'crypto'


export const NOTHING = 0
export const INFO    = 1
export const VERBOSE = 2

export let logLevel = INFO

export const setLogLevel = arg => {
	if (arg === true)
		logLevel = VERBOSE
	else if (arg === false)
		logLevel = NOTHING
	else if (typeof arg === 'number')
		logLevel = arg
	else
		logLevel = INFO
}

export function log(level, ...args) {
	if (level > logLevel) return
	if (level >= VERBOSE)
		console.log('\x1b[90m', ...args, '\x1b[0m')
	else
		console.log(...args)
}

export function removeFromArray(arr, item) {
	const index = arr.indexOf(item)
	if (index !== -1) {
		arr.splice(index, 1)
		return true
	}
}

export function applyOptions(target, defaultOpts, userOpts) {
	for (let key in defaultOpts) {
		let userVal = userOpts[key]
		let defaultVal = defaultOpts[key]
		if (typeof defaultVal === 'object')
			target[key] = applyOptions({}, defaultVal, userVal)
		else if (userVal !== undefined)
			target[key] = userVal
		else
			target[key] = defaultVal
	}
	return target
}

export function createCipher({cipher, key, iv}) {
	return {
		cipher: crypto.createCipheriv(cipher, key, iv),
		decipher: crypto.createDecipheriv(cipher, key, iv),
	}
}

export function canEncryptTunnel({cipher, key, iv}) {
	return !!cipher && !!key && !!iv
}