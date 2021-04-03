import crypto from 'crypto'


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