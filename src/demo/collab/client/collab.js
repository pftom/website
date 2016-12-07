const {exampleSetup, buildMenuItems} = require("prosemirror-example-setup")
const {Step} = require("prosemirror-transform")
const {MenuBarEditorView} = require("prosemirror-menu")
const {EditorState} = require("prosemirror-state")
const {history} = require("prosemirror-history")
const {collab, receiveAction, sendableSteps, getVersion} = require("prosemirror-collab")
const {MenuItem} = require("prosemirror-menu")
const crel = require("crel")

const {schema} = require("../schema")
const {GET, POST} = require("./http")
const {Reporter} = require("./reporter")
const {commentPlugin, commentUI, addAnnotation, annotationIcon} = require("./comment")

const report = new Reporter()

function badVersion(err) {
  return err.status == 400 && /invalid version/i.test(err)
}

class State {
  constructor(edit, comm) {
    this.edit = edit
    this.comm = comm
  }
}

class EditorConnection {
  constructor(report, url) {
    this.report = report
    this.url = url
    this.state = new State(null, "start")
    this.request = null
    this.backOff = 0
    this.view = null
    this.onAction = this.onAction.bind(this)
    this.start()
  }

  // All state changes go through this
  onAction(action) {
    let newEditState = null
    if (action.type == "loaded") {
      info.users.textContent = userString(action.users) // FIXME ewww
      let editState = EditorState.create({
        doc: action.doc,
        plugins: exampleSetup({schema, history: false}).concat([
          history({preserveItems: true}),
          collab({version: action.version}),
          commentPlugin,
          commentUI(this.onAction)
        ]),
        comments: action.comments
      })
      this.state = new State(editState, "poll")
      this.poll()
    } else if (action.type == "restart") {
      this.state = new State(null, "start")
      this.start()
    } else if (action.type == "poll") {
      this.state = new State(this.state.edit, "poll")
      this.poll()
    } else if (action.type == "recover") {
      if (action.error.status && action.error.status < 500) {
        this.report.failure(err)
        this.state = new State(null, null)
      } else {
        this.state = new State(this.state.edit, "recover")
        this.recover(action.error)
      }
    } else if (action.type == "receive") {
      newEditState = this.state.edit
      if (action.inner) newEditState = newEditState.applyAction(action.inner)
      newEditState = newEditState.applyAction(action)
    } else {
      newEditState = this.state.edit.applyAction(action)
    }

    if (newEditState) {
      let sendable
      if (newEditState.doc.content.size > 40000) {
        if (this.state.comm != "detached") this.report.failure("Document too big. Detached.")
        this.state = new State(newEditState, "detached")
      } else if ((this.state.comm == "poll" || action.requestDone) && (sendable = this.sendable(newEditState))) {
        this.closeRequest()
        this.state = new State(newEditState, "send")
        this.send(newEditState, sendable)
      } else if (action.requestDone) {
        this.state = new State(newEditState, "poll")
        this.poll()
      } else {
        this.state = new State(newEditState, this.state.comm)
      }
    }

    // Sync the editor with this.state.edit
    if (this.state.edit) {
      if (this.view)
        this.view.updateState(this.state.edit)
      else
        this.view = new MenuBarEditorView(document.querySelector("#editor"), {
          state: this.state.edit,
          onAction: this.onAction,
          menuContent: menu.fullMenu
        })
        window.view = this.view.editor
    } else if (this.view) {
      this.view.destroy()
      this.view = null
      window.view = undefined
    }
  }

  // Load the document from the server and start up
  start() {
    this.run(GET(this.url)).then(data => {
      data = JSON.parse(data)
      this.report.success()
      this.backOff = 0
      this.onAction({type: "loaded",
                     doc: schema.nodeFromJSON(data.doc),
                     version: data.version,
                     users: data.users,
                     comments: {version: data.commentVersion, comments: data.comments}})
    }, err => {
      this.report.failure(err)
    })
  }

  // Send a request for events that have happened since the version
  // of the document that the client knows about. This request waits
  // for a new version of the document to be created if the client
  // is already up-to-date.
  poll() {
    let query = "version=" + getVersion(this.state.edit) + "&commentVersion=" + commentPlugin.getState(this.state.edit).version
    this.run(GET(this.url + "/events?" + query)).then(data => {
      this.report.success()
      data = JSON.parse(data)
      this.backOff = 0
      if (data.steps && (data.steps.length || data.comment.length)) {
        let action = receiveAction(this.state.edit, data.steps.map(j => Step.fromJSON(schema, j)), data.clientIDs)
        this.onAction({type: "receive", inner: action, requestDone: true,
                       comments: {version: data.commentVersion, events: data.comment, sent: 0}})
      } else {
        this.poll()
      }
      info.users.textContent = userString(data.users)
    }, err => {
      if (err.status == 410 || badVersion(err)) {
        // Too far behind. Revert to server state
        report.failure(err)
        this.onAction({type: "restart"})
      } else if (err) {
        this.onAction({type: "recover", error: err})
      }
    })
  }

  sendable(editState) {
    let steps = sendableSteps(editState)
    let comments = commentPlugin.getState(editState).unsentEvents()
    if (steps || comments.length) return {steps, comments}
  }

  // Send the given steps to the server
  send(editState, {steps, comments}) {
    let json = JSON.stringify({version: getVersion(editState),
                               steps: steps ? steps.steps.map(s => s.toJSON()) : [],
                               clientID: steps ? steps.clientID : 0,
                               comment: comments || []})
    this.run(POST(this.url + "/events", json, "application/json")).then(data => {
      this.report.success()
      this.backOff = 0
      let action = steps && receiveAction(this.state.edit, steps.steps, repeat(steps.clientID, steps.steps.length))
      this.onAction({type: "receive", inner: action, requestDone: true,
                     comments: {version: JSON.parse(data).commentVersion, events: [], sent: comments.length}})
    }, err => {
      if (err.status == 409) {
        // The client's document conflicts with the server's version.
        // Poll for changes and then try again.
        this.backOff = 0
        this.onAction({type: "poll"})
      } else if (badVersion(err)) {
        this.report.failure(err)
        this.onAction({type: "restart"})
      } else {
        this.onAction({type: "recover", error: err})
      }
    })
  }

  // Try to recover from an error
  recover(err) {
    let newBackOff = this.backOff ? Math.min(this.backOff * 2, 6e4) : 200
    if (newBackOff > 1000 && this.backOff < 1000) this.report.delay(err)
    this.backOff = newBackOff
    setTimeout(() => {
      if (this.state.comm == "recover") this.onAction({type: "retry", requestDone: true})
    }, this.backOff)
  }

  closeRequest() {
    if (this.request) {
      this.request.abort()
      this.request = null
    }
  }

  run(request) {
    return this.request = request
  }

  close() {
    this.closeRequest()
    if (this.view) {
      document.querySelector("#editor").removeChild(this.view.wrapper)
      this.view = null
      window.view = undefined
    }
  }
}

function repeat(val, n) {
  let result = []
  for (let i = 0; i < n; i++) result.push(val)
  return result
}

const annotationMenuItem = new MenuItem({
  title: "Add an annotation",
  run: addAnnotation,
  select: state => addAnnotation(state),
  icon: annotationIcon
})
let menu = buildMenuItems(schema)
menu.fullMenu[0].push(annotationMenuItem)

let info = {
  name: document.querySelector("#docname"),
  users: document.querySelector("#users")
}
document.querySelector("#changedoc").addEventListener("click", e => {
  GET("/docs/").then(data => showDocList(e.target, JSON.parse(data)),
                     err => report.failure(err))
})

function userString(n) {
  if (n == null) n = 1
  return "(" + n + " user" + (n == 1 ? "" : "s") + ")"
}

let docList
function showDocList(node, list) {
  if (docList) docList.parentNode.removeChild(docList)

  let ul = docList = document.body.appendChild(crel("ul", {class: "doclist"}))
  list.forEach(doc => {
    ul.appendChild(crel("li", {"data-name": doc.id},
                        doc.id + " " + userString(doc.users)))
  })
  ul.appendChild(crel("li", {"data-new": "true", style: "border-top: 1px solid silver; margin-top: 2px"},
                      "Create a new document"))

  let rect = node.getBoundingClientRect()
  ul.style.top = (rect.bottom + 10 + pageYOffset - ul.offsetHeight) + "px"
  ul.style.left = (rect.left - 5 + pageXOffset) + "px"

  ul.addEventListener("click", e => {
    if (e.target.nodeName == "LI") {
      ul.parentNode.removeChild(ul)
      docList = null
      if (e.target.hasAttribute("data-name"))
        location.hash = "#edit-" + encodeURIComponent(e.target.getAttribute("data-name"))
      else
        newDocument()
    }
  })
}
document.addEventListener("click", () => {
  if (docList) {
    docList.parentNode.removeChild(docList)
    docList = null
  }
})

function newDocument() {
  let name = prompt("Name the new document", "")
  if (name)
    location.hash = "#edit-" + encodeURIComponent(name)
}

let connection = null

function connectFromHash() {
  let isID = /^#edit-(.+)/.exec(location.hash)
  if (isID) {
    if (connection) connection.close()
    info.name.textContent = decodeURIComponent(isID[1])
    connection = window.connection = new EditorConnection(report, "/docs/" + isID[1])
    connection.request.then(() => connection.view.editor.focus())
    return true
  }
}

addEventListener("hashchange", connectFromHash)
connectFromHash() || (location.hash = "#edit-Example")
