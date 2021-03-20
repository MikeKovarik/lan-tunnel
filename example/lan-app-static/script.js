let pre = document.querySelector('pre')
fetch('/devices')
	.then(res => res.json())
	.then(json => pre.innerHTML = JSON.stringify(json, null, 2))