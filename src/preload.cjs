// Exposes the one call the first-run page (setup.html) needs. Ledger's own
// pages get nothing: they talk to the server over HTTP like in a browser.
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
	contextBridge.exposeInMainWorld("bookkeeping", {
		createUser: (username, password) => ipcRenderer.invoke("setup:create-user", username, password),
	});
}
