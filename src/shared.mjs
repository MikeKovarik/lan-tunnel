export const NOTHING = 0
export const INFO    = 1
export const VERBOSE = 2
export const DEBUG   = 3

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

export function applyOptions(target, defaultOpts = {}, userOpts = {}) {
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

export function setupLongLivedSocket(socket) {
	socket.setTimeout(0)
	socket.setKeepAlive(true, 10000)
}

export const DESTRUCTION_TIMEOUT = Symbol('id')

export function killSocket(socket) {
	if (socket.closed) return
	socket.end()
	if (socket.destroyed) return
	if (socket[DESTRUCTION_TIMEOUT]) return
	socket[DESTRUCTION_TIMEOUT] = setTimeout(() => socket.destroy(), 500)
}

export function mutuallyAssuredSocketDestruction(a, b) {
	a.once('end',   () => killSocket(b))
	a.once('close', () => killSocket(b))
	b.once('end',   () => killSocket(a))
	b.once('close', () => killSocket(a))
}

export const ID = Symbol('id')
export const TYPE = Symbol('type')

const createId = () => Math.ceil(Math.random() * 999).toString().padStart(3, '0')
export const getId = socket => socket[ID] ? socket[ID] : socket[ID] = createId()
export const getDebugId = socket => `${(socket[TYPE] || '').slice(0,1)}:${getId(socket)}`
export const logSocket = (socket, ...args) => log(DEBUG, getDebugId(socket),  ...args)