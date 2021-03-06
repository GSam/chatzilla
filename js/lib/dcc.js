/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* We pick a random start ID, from 0 to DCC_ID_MAX inclusive, then go through
 * the IDs one at a time, in sequence. We wrap when we get to DCC_ID_MAX. No
 * uniqueness checking is done, but it takes DCC_ID_MAX connections before we
 * hit the start ID again. 65,536 IDs ought to be enough for now. :)
 */
const DCC_ID_MAX = 0xFFFF;

function CIRCDCC(parent)
{
    this.parent = parent;

    this.users = new Object();
    this.chats = new Array();
    this.files = new Array();
    this.last = null;
    this.lastTime = null;

    this.sendChunk = 4096;
    this.maxUnAcked = 32; // 4096 * 32 == 128KiB 'in transit'.

    this.requestTimeout = 3 * 60 * 1000; // 3 minutes.

    // Can't do anything 'til this is set!
    this.localIPlist = new Array();
    this.localIP = null;
    this._lastPort = null;

    try {
        var dnsComp = Components.classes["@mozilla.org/network/dns-service;1"];
        this._dnsSvc = dnsComp.getService(Components.interfaces.nsIDNSService);

        // Get local hostname.
        if ("myHostName" in this._dnsSvc) {
            // Using newer (1.7a+) version with DNS re-write.
            this.addHost(this._dnsSvc.myHostName);
        }
        if ("myIPAddress" in this._dnsSvc) {
            // Older Mozilla, have to use this method.
            this.addIP(this._dnsSvc.myIPAddress);
        }
        this.addHost("localhost");
    } catch(ex) {
        // what to do?
        dd("Error getting local IPs: " + ex);
    }

    this._lastID = Math.round(Math.random() * DCC_ID_MAX);

    return this;
}

CIRCDCC.prototype.TYPE = "IRCDCC";
CIRCDCC.prototype.listenPorts = [];

CIRCDCC.prototype.addUser =
function dcc_adduser(user, remoteIP)
{
    // user     == CIRCUser object.
    // remoteIP == remoteIP as specified in CTCP DCC message.
    return new CIRCDCCUser(this, user, remoteIP);
}

CIRCDCC.prototype.abortReplaced =
function dcc_abortreplaced(ip, port, exclude)
{
    // Catch if there is an existing non-connected incoming file transfer or
    // DCC chat offer with the same IP and port; cancel old offers found, since
    // clients identify connections by their port (and not their names...)
    var k;
    for (k = 0; k < this.chats.length; k++)
    {
        if ((this.chats[k] != exclude) &&
            (this.chats[k].port == port) &&
            (this.chats[k].remoteIP == ip) &&
            (this.chats[k].state.dir == DCC_DIR_GETTING) &&
            (this.chats[k].state.state == DCC_STATE_REQUESTED))
        {
            this.chats[k].abort();
        }
    }

    for (k = 0; k < this.files.length; k++)
    {
        if ((this.files[k] != exclude) &&
            (this.files[k].port == port) &&
            (this.files[k].remoteIP == ip) &&
            (this.files[k].state.dir == DCC_DIR_GETTING) &&
            (arrayIndexOf([DCC_STATE_REQUESTED, DCC_STATE_RESUMING],
                          this.files[k].state.state) >= 0))
        {
            this.files[k].abort();
        }
    }
}

CIRCDCC.prototype.addChat =
function dcc_addchat(user, port)
{
    // user == CIRCDCCUser object.
    // port == port as specified in CTCP DCC message.
    return new CIRCDCCChat(this, user, port);
}

CIRCDCC.prototype.addFileTransfer =
function dcc_addfile(user, port, file, size)
{
    return new CIRCDCCFileTransfer(this, user, port, file, size);
}

CIRCDCC.prototype.addHost =
function dcc_addhost(host, auth)
{
    var me = this;
    var listener = {
        onLookupComplete: function _onLookupComplete(request, record, status) {
            // record == null if it failed. We can't do anything with a failure.
            if (record)
            {
                while (record.hasMore())
                    me.addIP(record.getNextAddrAsString(), auth);
            }
        }
    };

    try {
        var th;
        if (jsenv.HAS_THREAD_MANAGER) {
          th = getService("@mozilla.org/thread-manager;1").currentThread;
        } else {
          const EQS = getService("@mozilla.org/event-queue-service;1",
                                 "nsIEventQueueService");
          th = EQS.getSpecialEventQueue(EQS.CURRENT_THREAD_EVENT_QUEUE);
        }
        var dnsRecord = this._dnsSvc.asyncResolve(host, false, listener, th);
    } catch (ex) {
        dd("Error resolving host to IP: " + ex);
    }
}

CIRCDCC.prototype.addIP =
function dcc_addip(ip, auth)
{
    if (auth)
        this.localIPlist.unshift(ip);
    else
        this.localIPlist.push(ip);

    if (this.localIPlist.length > 0)
        this.localIP = this.localIPlist[0];
}

CIRCDCC.prototype.renameUser =
function dcc_renameuser(user)
{
    if (user.dccUser)
        user.dccUser.rename();
}

CIRCDCC.prototype.findFileTransfer =
function dcc_findfiletransfer(file, exclude)
{
    // Search for any active file transfer attached to the chosen file,
    // except the file transfer doing the searching (if any)
    for (k = 0; k < this.files.length; k++)
    {
        if ((this.files[k] != exclude) &&
            (this.files[k].state.dir == DCC_DIR_GETTING) &&
            (this.files[k].isActive()) &&
            (((this.files[k].localPath) &&
              (file.path == this.files[k].localPath)) ||
             ((this.files[k].localFile) &&
              (file.equals(this.files[k].localFile.localFile))) ||
             ((this.files[k].resumingPick) &&
              (file.equals(this.files[k].resumingPick)))))
        {
            return this.files[k];
        }
    }
    return undefined;
}

CIRCDCC.prototype.getMatches =
function dcc_getmatches(nickname, filename, types, dirs, states, port)
{
    function matchNames(name, otherName)
    {
        return ((name.match(new RegExp(otherName, "i"))) ||
                (name.toLowerCase().indexOf(otherName.toLowerCase()) != -1));
    };

    var k;
    var list = new Array();
    if (!types)
        types = ["chat", "file"];

    var n = nickname;
    var f = filename;

    if (arrayIndexOf(types, "chat") >= 0)
    {
        for (k = 0; k < this.chats.length; k++)
        {
            if ((!nickname || matchNames(this.chats[k].user.unicodeName, n)) &&
                (!dirs || arrayIndexOf(dirs, this.chats[k].state.dir) >= 0) &&
                (!states ||
                 arrayIndexOf(states, this.chats[k].state.state) >= 0) &&
                (!port || this.chats[k].port == port))
            {
                list.push(this.chats[k]);
            }
        }
    }
    if (arrayIndexOf(types, "file") >= 0)
    {
        for (k = 0; k < this.files.length; k++)
        {
            if ((!nickname || matchNames(this.files[k].user.unicodeName, n)) &&
                (!filename || matchNames(this.files[k].filename, f)) &&
                (!dirs || arrayIndexOf(dirs, this.files[k].state.dir) >= 0) &&
                (!states ||
                 arrayIndexOf(states, this.files[k].state.state) >= 0) &&
                (!port || this.files[k].port == port))
            {
                list.push(this.files[k]);
            }
        }
    }

    return list;
}

CIRCDCC.prototype.getNextPort =
function dcc_getnextport()
{
    var portList = this.listenPorts;

    var newPort = this._lastPort;

    for (var i = 0; i < portList.length; i++)
    {
        var m = portList[i].match(/^(\d+)(?:-(\d+))?$/);
        if (m)
        {
            if (!newPort)
            {
                // We dodn't have any previous port, so just take the first we
                // find.
                return this._lastPort = Number(m[1]);
            }
            else if (arrayHasElementAt(m, 2))
            {
                // Port range. Anything before range, or in [exl. last value]
                // is ok. Make sure first value is lowest value returned.
                if (newPort < m[2])
                    return this._lastPort = Math.max(newPort + 1, Number(m[1]));
            }
            else
            {
                // Single port.
                if (newPort < m[1])
                    return this._lastPort = Number(m[1]);
            }
        }
    }

    // No ports found, and no last port --> use OS.
    if (newPort == null)
        return -1;

    // Didn't find anything... d'oh. Need to start from the begining again.
    this._lastPort = null;
    return this.getNextPort();
}

CIRCDCC.prototype.getNextID =
function dcc_getnextid()
{
    this._lastID++;
    if (this._lastID > DCC_ID_MAX)
        this._lastID = 0;

    // Format to DCC_ID_MAX's number of digits.
    var id = this._lastID.toString(16);
    while (id.length < DCC_ID_MAX.toString(16).length)
        id = "0" + id;
    return id;
}

CIRCDCC.prototype.findByID =
function dcc_findbyid(id)
{
    if (typeof id != "string")
        return null;

    var i;
    for (i = 0; i < this.chats.length; i++)
    {
        if (this.chats[i].id == id)
            return this.chats[i];
    }
    for (i = 0; i < this.files.length; i++)
    {
        if (this.files[i].id == id)
            return this.files[i];
    }
    return null;
}


// JavaScript won't let you delete things declared with "var", workaround:
window.val = -1;

const DCC_STATE_FAILED        = val++; // try connect (accept), but it failed.
const DCC_STATE_INIT          = val++; // not "doing" anything
const DCC_STATE_RESUMING      = val++; // RESUME request sent
const DCC_STATE_REQUESTED     = val++; // waiting
const DCC_STATE_ACCEPTED      = val++; // accepted.
const DCC_STATE_DECLINED      = val++; // declined.
const DCC_STATE_CONNECTED     = val++; // all going ok.
const DCC_STATE_DONE          = val++; // finished ok.
const DCC_STATE_ABORTED       = val++; // send wasn't accepted in time.

delete window.val;

const DCC_DIR_UNKNOWN = 0;
const DCC_DIR_SENDING = 1;
const DCC_DIR_GETTING = 2;


function CIRCDCCUser(parent, user, remoteIP)
{
    // user     == CIRCUser object.
    // remoteIP == remoteIP as specified in CTCP DCC message.

    if ("dccUser" in user)
    {
        if (remoteIP)
            user.dccUser.remoteIP = remoteIP;

        return user.dccUser;
    }

    this.parent = parent;
    this.netUser = user;
    this.id = parent.getNextID();
    this.unicodeName = user.unicodeName;
    this.viewName = user.unicodeName;
    this.canonicalName = user.canonicalName;
    this.remoteIP = remoteIP;

    this.key = escape(this.canonicalName) + ":" + remoteIP;
    user.dccUser = this;
    this.parent.users[this.key] = this;

    if ("onInit" in this)
        this.onInit();

    return this;
}

CIRCDCCUser.prototype.rename =
function dccuser_rename()
{
    this.unicodeName = this.netUser.unicodeName;
    this.viewName = this.netUser.unicodeName;
    this.canonicalName = this.netUser.canonicalName;

    var oldkey = this.key;
    this.key = escape(this.canonicalName) + ":" + this.remoteIP;
    renameProperty(this.parent.users, oldkey, this.key);
}

CIRCDCCUser.prototype.TYPE = "IRCDCCUser";


// Keeps track of the state of a DCC connection.
function CIRCDCCState(parent, owner, eventType)
{
    // parent    == central CIRCDCC object.
    // owner     == DCC Chat or File object.
    // eventType == "dcc-chat" or "dcc-file".

    this.parent = parent;
    this.owner = owner;
    this.eventType = eventType;

    this.eventPump = owner.eventPump;

    this.state = DCC_STATE_INIT;
    this.dir = DCC_DIR_UNKNOWN;

    return this;
}

CIRCDCCState.prototype.TYPE = "IRCDCCState";

CIRCDCCState.prototype.sendRequest =
function dccstate_sendRequest()
{
    if (!this.parent.localIP || (this.state != DCC_STATE_INIT))
        throw "Must have a local IP and be in INIT state.";

    this.state = DCC_STATE_REQUESTED;
    this.dir = DCC_DIR_SENDING;
    this.requested = new Date();

    this.requestTimeout = setTimeout(function (o){ o.abort(); },
                                     this.parent.requestTimeout, this.owner);

    this.eventPump.addEvent(new CEvent(this.eventType, "request",
                                       this.owner, "onRequest"));
}

CIRCDCCState.prototype.getRequest =
function dccstate_getRequest()
{
    if (this.state != DCC_STATE_INIT)
        throw "Must be in INIT state.";

    this.state = DCC_STATE_REQUESTED;
    this.dir = DCC_DIR_GETTING;
    this.requested = new Date();

    this.parent.last = this.owner;
    this.parent.lastTime = new Date();

    this.requestTimeout = setTimeout(function (o){ o.abort(); },
                                     this.parent.requestTimeout, this.owner);

    this.eventPump.addEvent(new CEvent(this.eventType, "request",
                                       this.owner, "onRequest"));
}

CIRCDCCState.prototype.sendResume =
function dccstate_sendResume()
{
    if (((this.state != DCC_STATE_REQUESTED) &&
         (this.state != DCC_STATE_RESUMING)) ||
        (this.dir != DCC_DIR_GETTING))
    {
        throw "Must be in REQUESTED state and direction GET.";
    }

    clearTimeout(this.requestTimeout);
    this.requestTimeout = setTimeout(function (o){ o.abort(); },
                                     this.parent.requestTimeout, this.owner);

    this.state = DCC_STATE_RESUMING;

    this.eventPump.addEvent(new CEvent(this.eventType, "resuming",
                                       this.owner, "onResuming"));
}

CIRCDCCState.prototype.getResume =
function dccstate_getResume()
{
    if ((this.state != DCC_STATE_REQUESTED) ||
        (this.dir != DCC_DIR_SENDING))
    {
        throw "Must be in REQUESTED state and direction SEND.";
    }

    clearTimeout(this.requestTimeout);
    this.requestTimeout = setTimeout(function (o){ o.abort(); },
                                     this.parent.requestTimeout, this.owner);

    this.eventPump.addEvent(new CEvent(this.eventType, "resuming",
                                       this.owner, "onResuming"));
}

CIRCDCCState.prototype.sendAccept =
function dccstate_sendAccept()
{
    if (((this.state != DCC_STATE_REQUESTED) &&
         (this.state != DCC_STATE_RESUMING)) ||
        (this.dir != DCC_DIR_GETTING))
    {
        throw "Must be in REQUESTED state and direction GET.";
    }

    // Clear out "last" incoming request if that's us.
    if (this.parent.last == this.owner)
    {
        this.parent.last = null;
        this.parent.lastTime = null;
    }

    clearTimeout(this.requestTimeout);
    delete this.requestTimeout;

    this.state = DCC_STATE_ACCEPTED;
    this.accepted = new Date();

    this.eventPump.addEvent(new CEvent(this.eventType, "accept",
                                       this.owner, "onAccept"));
}

CIRCDCCState.prototype.getAccept =
function dccstate_getAccept()
{
    if ((this.state != DCC_STATE_REQUESTED) || (this.dir != DCC_DIR_SENDING))
        throw "Must be in REQUESTED state and direction SEND.";

    clearTimeout(this.requestTimeout);
    delete this.requestTimeout;

    this.state = DCC_STATE_ACCEPTED;
    this.accepted = new Date();

    this.eventPump.addEvent(new CEvent(this.eventType, "accept",
                                       this.owner, "onAccept"));
}

CIRCDCCState.prototype.sendDecline =
function dccstate_sendDecline()
{
    if (((this.state != DCC_STATE_REQUESTED) &&
         (this.state != DCC_STATE_RESUMING)) ||
        (this.dir != DCC_DIR_GETTING))
    {
        throw "Must be in REQUESTED state and direction GET.";
    }

    // Clear out "last" incoming request if that's us.
    if (this.parent.last == this.owner)
    {
        this.parent.last = null;
        this.parent.lastTime = null;
    }

    clearTimeout(this.requestTimeout);
    delete this.requestTimeout;

    this.state = DCC_STATE_DECLINED;
    this.declined = new Date();

    this.eventPump.addEvent(new CEvent(this.eventType, "decline",
                                       this.owner, "onDecline"));
}

CIRCDCCState.prototype.getDecline =
function dccstate_getDecline()
{
    if ((this.state != DCC_STATE_REQUESTED) || (this.dir != DCC_DIR_SENDING))
        throw "Must be in REQUESTED state and direction SEND.";

    clearTimeout(this.requestTimeout);
    delete this.requestTimeout;

    this.state = DCC_STATE_DECLINED;
    this.declined = new Date();

    this.eventPump.addEvent(new CEvent(this.eventType, "decline",
                                       this.owner, "onDecline"));
}

// The sockets connected.
CIRCDCCState.prototype.socketConnected =
function dccstate_socketConnected()
{
    if (this.state != DCC_STATE_ACCEPTED)
        throw "Not in ACCEPTED state.";

    this.state = DCC_STATE_CONNECTED;

    this.eventPump.addEvent(new CEvent(this.eventType, "connect",
                                       this.owner, "onConnect"));
}

// Someone disconnected something.
CIRCDCCState.prototype.socketDisconnected =
function dccstate_socketDisconnected()
{
    if (this.state != DCC_STATE_CONNECTED)
        throw "Not CONNECTED!";

    this.state = DCC_STATE_DONE;

    this.eventPump.addEvent(new CEvent(this.eventType, "disconnect",
                                       this.owner, "onDisconnect"));
}

CIRCDCCState.prototype.sendAbort =
function dccstate_sendAbort()
{
    if ((this.state != DCC_STATE_REQUESTED) &&
        (this.state != DCC_STATE_ACCEPTED) &&
        (this.state != DCC_STATE_CONNECTED))
    {
        throw "Can't abort at this point.";
    }

    this.state = DCC_STATE_ABORTED;

    this.eventPump.addEvent(new CEvent(this.eventType, "abort",
                                       this.owner, "onAbort"));
}

CIRCDCCState.prototype.getAbort =
function dccstate_getAbort()
{
    if ((this.state != DCC_STATE_REQUESTED) &&
        (this.state != DCC_STATE_ACCEPTED) &&
        (this.state != DCC_STATE_CONNECTED))
    {
        throw "Can't abort at this point.";
    }

    this.state = DCC_STATE_ABORTED;

    this.eventPump.addEvent(new CEvent(this.eventType, "abort",
                                       this.owner, "onAbort"));
}

CIRCDCCState.prototype.failed =
function dccstate_failed()
{
    if ((this.state != DCC_STATE_REQUESTED) &&
        (this.state != DCC_STATE_ACCEPTED) &&
        (this.state != DCC_STATE_CONNECTED))
    {
        throw "Can't fail at this point.";
    }

    this.state = DCC_STATE_FAILED;

    this.eventPump.addEvent(new CEvent(this.eventType, "fail",
                                       this.owner, "onFail"));
}




function CIRCDCCChat(parent, user, port)
{
    // user == CIRCDCCUser object.
    // port == port as specified in CTCP DCC message.

    this.READ_TIMEOUT = 50;

    // Link up all our data.
    this.parent = parent;
    this.id = parent.getNextID();
    this.eventPump = parent.parent.eventPump;
    this.user = user;
    this.localIP = this.parent.localIP;
    this.remoteIP = user.remoteIP;
    this.port = port;
    this.unicodeName = user.unicodeName;
    this.viewName = "DCC: " + user.unicodeName;

    // Set up the initial state.
    this.requested = null;
    this.connection = null;
    this.savedLine = "";
    this.state = new CIRCDCCState(parent, this, "dcc-chat");
    this.parent.chats.push(this);

    // Give ourselves a "me" object for the purposes of displaying stuff.
    this.me = this.parent.addUser(this.user.netUser.parent.me, "0.0.0.0");

    if ("onInit" in this)
        this.onInit();

    return this;
}

CIRCDCCChat.prototype.TYPE = "IRCDCCChat";

CIRCDCCChat.prototype.getURL =
function dchat_geturl()
{
    return "x-irc-dcc-chat:" + this.id;
}

CIRCDCCChat.prototype.isActive =
function dchat_isactive()
{
    return (this.state.state == DCC_STATE_REQUESTED) ||
           (this.state.state == DCC_STATE_ACCEPTED) ||
           (this.state.state == DCC_STATE_CONNECTED);
}

// Call to make this end request DCC Chat with targeted user.
CIRCDCCChat.prototype.request =
function dchat_request()
{
    this.state.sendRequest();

    this.localIP = this.parent.localIP;

    this.connection = new CBSConnection();
    if (!this.connection.listen(this.port, this))
    {
        this.state.failed();
        return false;
    }

    this.port = this.connection.port;

    // Send the CTCP DCC request via the net user (CIRCUser object).
    var ipNumber;
    var ipParts = this.localIP.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
    if (ipParts)
        ipNumber = Number(ipParts[1]) * 256 * 256 * 256 +
                   Number(ipParts[2]) * 256 * 256 +
                   Number(ipParts[3]) * 256 +
                   Number(ipParts[4]);
    else
        return false;
        // What should we do here? Panic?

    this.user.netUser.ctcp("DCC", "CHAT chat " + ipNumber + " " + this.port);

    return true;
}

// Call to make this end accept DCC Chat with target user.
CIRCDCCChat.prototype.accept =
function dchat_accept()
{
    this.state.sendAccept();

    this.connection = new CBSConnection();
    this.connection.connect(this.remoteIP, this.port, null, this);

    return true;
}

// This may be called synchronously or asynchronously by CBSConnection.connect.
CIRCDCCChat.prototype.onSocketConnection =
function dchat_onsocketconnection(host, port, config, exception)
{
    if (!exception)
    {
        this.state.socketConnected();

        if (jsenv.HAS_NSPR_EVENTQ)
            this.connection.startAsyncRead(this);
        else
            this.eventPump.addEvent(new CEvent("dcc-chat", "poll",
                                               this, "onPoll"));
    }
    else
    {
        this.state.failed();
    }
}

// Call to make this end decline DCC Chat with target user.
CIRCDCCChat.prototype.decline =
function dchat_decline()
{
    this.state.sendDecline();

    // Tell the other end, if they care, that we refused.
    this.user.netUser.ctcp("DCC", "REJECT CHAT chat");

    return true;
}

// Call to close the connection.
CIRCDCCChat.prototype.disconnect =
function dchat_disconnect()
{
    this.connection.disconnect();

    return true;
}

// Aborts the connection.
CIRCDCCChat.prototype.abort =
function dchat_abort()
{
    if (this.state.state == DCC_STATE_CONNECTED)
    {
        this.disconnect();
        return;
    }

    this.state.sendAbort();

    if (this.connection)
        this.connection.close();
}

// Event to handle a request from the target user.
// CIRCUser points the event here.
CIRCDCCChat.prototype.onGotRequest =
function dchat_onGotRequest(e)
{
    this.state.getRequest();
    this.parent.abortReplaced(this.remoteIP, this.port, this);

    // Pass over to the base user.
    e.destObject = this.user.netUser;
}

// Event to handle a client connecting to the listening socket.
// CBSConnection points the event here.
CIRCDCCChat.prototype.onSocketAccepted =
function dchat_onSocketAccepted(socket, transport)
{
    this.state.getAccept();

    this.connection.accept(transport, null);

    this.state.socketConnected();

    this.remoteIP = transport.host;

    // Start the reading!
    if (jsenv.HAS_NSPR_EVENTQ)
        this.connection.startAsyncRead(this);
    else
        this.eventPump.addEvent(new CEvent("dcc-chat", "poll",
                                           this, "onPoll"));
}

CIRCDCCChat.prototype.onPoll =
function dchat_poll (e)
{
    var line = "";
    var ev;

    try
    {
        line = this.connection.readData(this.READ_TIMEOUT);
    }
    catch (ex)
    {
        if (typeof (ex) != "undefined")
        {
            this.connection.disconnect();
            ev = new CEvent("dcc-chat", "close", this, "onClose");
            ev.reason = "read-error";
            ev.exception = ex;
            this.eventPump.addEvent(ev);
            return false;
        }
        else
            line = "";
    }

    this.eventPump.addEvent(new CEvent("dcc-chat", "poll",
                                       this, "onPoll"));

    if (line == "")
        return false;

    ev = new CEvent("dcc-chat", "data-available", this, "onDataAvailable");
    ev.line = line;
    this.eventPump.routeEvent(ev);

    return true;
}

CIRCDCCChat.prototype.onStreamDataAvailable =
function dchat_sda(request, inStream, sourceOffset, count)
{
    var ev = new CEvent("dcc-chat", "data-available", this, "onDataAvailable");
    ev.line = this.connection.readData(0, count);
    this.eventPump.routeEvent(ev);
}

CIRCDCCChat.prototype.onStreamClose =
function dchat_sockdiscon(status)
{
    this.state.socketDisconnected();

    //var ev = new CEvent("dcc-chat", "disconnect", this, "onDisconnect");
    //ev.server = this;
    //ev.disconnectStatus = status;
    //this.eventPump.addEvent(ev);
}

CIRCDCCChat.prototype.onDataAvailable =
function dchat_dataavailable(e)
{
    var line = e.line;

    var incomplete = (line[line.length] != '\n');
    var lines = line.split("\n");

    if (this.savedLine)
    {
        lines[0] = this.savedLine + lines[0];
        this.savedLine = "";
    }

    if (incomplete)
        this.savedLine = lines.pop();

    for (var i in lines)
    {
        var ev = new CEvent("dcc-chat", "rawdata", this, "onRawData");
        ev.data = lines[i];
        ev.replyTo = this;
        this.eventPump.addEvent (ev);
    }

    return true;
}

// Raw data from DCC Chat stream.
CIRCDCCChat.prototype.onRawData =
function dchat_rawdata(e)
{
    e.code = "PRIVMSG";
    e.line = e.data;
    e.user = this.user;
    e.type = "parseddata";
    e.destObject = this;
    e.destMethod = "onParsedData";

    return true;
}

CIRCDCCChat.prototype.onParsedData =
function dchat_onParsedData(e)
{
    e.type = e.code.toLowerCase();
    if (!e.code[0])
    {
        dd (dumpObjectTree (e));
        return false;
    }

    if (e.line.search(/\x01.*\x01/i) != -1) {
        e.type = "ctcp";
        e.destMethod = "onCTCP";
        e.set = "dcc-chat";
        e.destObject = this;
    }
    else
    {
        e.type = "privmsg";
        e.destMethod = "onPrivmsg";
        e.set = "dcc-chat";
        e.destObject = this;
    }

    // Allow DCC Chat to handle it before "falling back" to DCC User.
    if (typeof this[e.destMethod] == "function")
        e.destObject = this;
    else if (typeof this.user[e.destMethod] == "function")
        e.destObject = this.user;
    else if (typeof this["onUnknown"] == "function")
        e.destMethod = "onUnknown";
    else if (typeof this.parent[e.destMethod] == "function")
    {
        e.set = "dcc";
        e.destObject = this.parent;
    }
    else
    {
        e.set = "dcc";
        e.destObject = this.parent;
        e.destMethod = "onUnknown";
    }

    return true;
}

CIRCDCCChat.prototype.onCTCP =
function serv_ctcp(e)
{
    // The \x0D? is a BIG HACK to make this work with X-Chat.
    var ary = e.line.match(/^\x01([^ ]+) ?(.*)\x01\x0D?$/i);
    if (ary == null)
        return false;

    e.CTCPData = ary[2] ? ary[2] : "";
    e.CTCPCode = ary[1].toLowerCase();
    if (e.CTCPCode.search(/^reply/i) == 0)
    {
        dd("dropping spoofed reply.");
        return false;
    }

    e.CTCPCode = toUnicode(e.CTCPCode, e.replyTo);
    e.CTCPData = toUnicode(e.CTCPData, e.replyTo);

    e.type = "ctcp-" + e.CTCPCode;
    e.destMethod = "onCTCP" + ary[1][0].toUpperCase() +
                   ary[1].substr(1, ary[1].length).toLowerCase();

    if (typeof this[e.destMethod] != "function")
    {
        e.destObject = e.user;
        e.set = "dcc-user";
        if (typeof e.user[e.destMethod] != "function")
        {
            e.type = "unk-ctcp";
            e.destMethod = "onUnknownCTCP";
        }
    }
    else
    {
        e.destObject = this;
    }
    return true;
}

CIRCDCCChat.prototype.ctcp =
function dchat_ctcp(code, msg)
{
    msg = msg || "";

    this.connection.sendData("\x01" + fromUnicode(code, this) + " " +
                             fromUnicode(msg, this) + "\x01\n");
}

CIRCDCCChat.prototype.say =
function dchat_say (msg)
{
    this.connection.sendData(fromUnicode(msg, this) + "\n");
}

CIRCDCCChat.prototype.act =
function dchat_act(msg)
{
    this.ctcp("ACTION", msg);
}


function CIRCDCCFileTransfer(parent, user, port, file, size)
{
    // user == CIRCDCCUser object.
    // port == port as specified in CTCP DCC message.
    // file == name of file being sent/got.
    // size == size of said file.

    this.READ_TIMEOUT = 50;

    // Link up all our data.
    this.parent = parent;
    this.id = parent.getNextID();
    this.eventPump = parent.parent.eventPump;
    this.user = user;
    this.localIP = this.parent.localIP;
    this.remoteIP = user.remoteIP;
    this.port = port;
    this.filename = file;
    this.size = size;
    this.unicodeName = user.unicodeName;
    this.viewName = "File: " + this.filename;

    // Set up the initial state.
    this.requested = null;
    this.connection = null;
    this.state = new CIRCDCCState(parent, this, "dcc-file");
    this.parent.files.push(this);

    // Give ourselves a "me" object for the purposes of displaying stuff.
    this.me = this.parent.addUser(this.user.netUser.parent.me, "0.0.0.0");

    if ("onInit" in this)
        this.onInit();

    return this;
}

CIRCDCCFileTransfer.prototype.TYPE = "IRCDCCFileTransfer";

CIRCDCCFileTransfer.prototype.getURL =
function dfile_geturl()
{
    return "x-irc-dcc-file:" + this.id;
}

CIRCDCCFileTransfer.prototype.isActive =
function dfile_isactive()
{
    return (this.state.state == DCC_STATE_REQUESTED) ||
           (this.state.state == DCC_STATE_ACCEPTED) ||
           (this.state.state == DCC_STATE_CONNECTED);
}

CIRCDCCFileTransfer.prototype.dispose =
function dfile_dispose()
{
    if (this.connection)
    {
        // close is for the server socket, disconnect for the client socket.
        this.connection.close();
        this.connection.disconnect();
    }

    if (this.localFile)
        this.localFile.close();

    this.connection = null;
    this.localFile = null;
    this.filestream = null;
}

CIRCDCCFileTransfer.prototype.isActive =
function dfile_is_active()
{
    return (arrayIndexOf([DCC_STATE_RESUMING, DCC_STATE_ACCEPTED,
                          DCC_STATE_CONNECTED, DCC_STATE_REQUESTED],
                         this.state.state) >= 0);
}

CIRCDCCFileTransfer.prototype.isSameFile =
function dfile_is_same_file(other)
{
    return ((this.filename == other.filename) &&
            (this.size == other.size) &&
            (this.user == other.user));
}

// Call to make this end offer DCC File to targeted user.
CIRCDCCFileTransfer.prototype.request =
function dfile_request(localFile)
{
    this.state.sendRequest();

    this.localFile = new LocalFile(localFile, "<");
    this.filename = localFile.leafName;
    this.size = localFile.fileSize;

    // Check if we're trying to send a file currently receiving a transfer
    var rcv = this.parent.findFileTransfer(localFile, this);
    if (rcv)
        this.size = rcv.size;

    // Update view name.
    this.viewName = "File: " + this.filename;

    // Double-quote file names with spaces.
    // Use a temporary variable so we don't mess up the filename field for
    // later matches (if the targeted user tries to use DCC RESUME)
    // FIXME: Do we need any better checking?
    var needQuotes = "";
    if (/\s/.test(this.filename))
        needQuotes = '"';

    this.localIP = this.parent.localIP;

    this.connection = new CBSConnection(true);
    if (!this.connection.listen(this.port, this))
    {
        this.state.failed();
        this.dispose();
        return false;
    }

    this.port = this.connection.port;

    // Send the CTCP DCC request via the net user (CIRCUser object).
    var ipNumber;
    var ipParts = this.localIP.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
    if (ipParts)
        ipNumber = Number(ipParts[1]) * 256 * 256 * 256 +
                   Number(ipParts[2]) * 256 * 256 +
                   Number(ipParts[3]) * 256 +
                   Number(ipParts[4]);
    else
        return false;
    // What should we do here? Panic?

    this.user.netUser.ctcp("DCC", "SEND " +
                           needQuotes + this.filename + needQuotes + " " +
                           ipNumber + " " + this.port + " " + this.size);

    return true;
}

// Call to make this end accept DCC File from target user.
CIRCDCCFileTransfer.prototype.accept =
function dfile_accept(localFile)
{
    const nsIBinaryOutputStream = Components.interfaces.nsIBinaryOutputStream;

    this.state.sendAccept();

    // If DCC RESUME has been requested and answered successfully, append to
    // the local target file
    if (("resumingAt" in this) && ("resumingPick" in this))
    {
        // Ensure that the point we are resuming at really is the end of the
        // existing file
        if (this.resumingAt != localFile.fileSize)
            return false;
        this.localFile = new LocalFile(localFile, ">>");
    }
    else
    {
        this.localFile = new LocalFile(localFile, ">");
        delete this.reofferFor;
    }
    this.localPath = localFile.path;

    this.filestream = Components.classes["@mozilla.org/binaryoutputstream;1"];
    this.filestream = this.filestream.createInstance(nsIBinaryOutputStream);
    this.filestream.setOutputStream(this.localFile.outputStream);

    this.position = 0;

    // If we are resuming a transfer, our current position is the place we are
    // resuming from
    if (("resumingAt" in this) && ("resumingPick" in this))
        this.position = this.resumingAt;

    // Once the connection is in place, and our position is properly set, the
    // fact that we are resuming a transfer has no further effect.
    // If we tried to resume, and we received no confirmation of the other
    // client's acceptance, we can no longer respond to a confirmation.
    delete this.resumingAt;
    delete this.resumingPick;

    this.connection = new CBSConnection(true);
    this.connection.connect(this.remoteIP, this.port, null, this);

    return true;
}

// This may be called synchronously or asynchronously by CBSConnection.connect.
CIRCDCCFileTransfer.prototype.onSocketConnection =
function dfile_onsocketconnection(host, port, config, exception)
{
    if (!exception)
    {
        this.state.socketConnected();

        if (jsenv.HAS_NSPR_EVENTQ)
            this.connection.startAsyncRead(this);
        else
            this.eventPump.addEvent(new CEvent("dcc-file", "poll",
                                               this, "onPoll"));
    }
    else
    {
        this.state.failed();
        this.dispose();
    }
}

// Call to make this end decline DCC File from target user.
CIRCDCCFileTransfer.prototype.decline =
function dfile_decline()
{
    this.state.sendDecline();

    // Tell the other end, if they care, that we refused.
    this.user.netUser.ctcp("DCC", "REJECT FILE " + this.filename);

    return true;
}

// Call to close the connection.
CIRCDCCFileTransfer.prototype.disconnect =
function dfile_disconnect()
{
    this.dispose();

    return true;
}

// Aborts the connection.
CIRCDCCFileTransfer.prototype.abort =
function dfile_abort()
{
    if (this.state.state == DCC_STATE_CONNECTED)
    {
        this.disconnect();
        this.state.sendAbort();
        return;
    }

    this.state.sendAbort();
    this.dispose();
}

CIRCDCCFileTransfer.prototype.resume =
function dfile_resume(localFile)
{
    // To resume a transfer into a file, the file must exist and it must be
    // smaller than the size of the completed transfer
    if ((! localFile.exists()) || (localFile.fileSize >= this.size))
        return false;

    // We should also ensure that the chosen file to write to isn't already
    // receiving a file transfer
    if (this.parent.findFileTransfer(localFile, this))
        return false;

    this.state.sendResume();
    this.resumingPick = localFile;

    // Determine if quotes need to be added to the filename we pass
    var needQuotes = "";
    if (/\s/.test(this.filename))
        needQuotes = '"';

    // Ask the offering client to resume from the end of our available length
    this.user.netUser.ctcp("DCC", "RESUME " +
                           needQuotes + this.filename + needQuotes + " " +
                           this.port + " " + localFile.fileSize);

    return true;
}

CIRCDCCFileTransfer.prototype.resuming =
function dfile_resuming(resumeAt)
{
    // This completes the connection to resume a transfer.
    // It should not be called before the sending client has responded to
    // the DCC RESUME message sent to it.
    if (! this.resumingPick)
        return false;

    // On SeaMonkey 1.1.14, this next line is required to update the
    // nsLocalFile instance's file status information.
    this.resumingPick = new nsLocalFile(this.resumingPick.path);

    // If the destination file no longer exists, or its size has changed
    // since the RESUME request was sent, the transfer offer is no longer
    // valid, and should be rejected -- either someone else is writing to
    // the file, or the user might have erased or moved the file as a way
    // to cancel the transfer.
    if ((! this.resumingPick.exists()) ||
        (this.resumingPick.fileSize != resumeAt))
    {
        this.state.failed();
        this.user.netUser.ctcp("DCC", "REJECT FILE " + this.filename);
        this.dispose();
        return false;
    }

    this.resumingAt = resumeAt;

    return ((this.accept(this.resumingPick)) ||
            (this.state == DCC_STATE_CONNECTED) ||
            (this.state.state == DCC_STATE_CONNECTED));
}

CIRCDCCFileTransfer.prototype.onGotResume =
function dfile_onGotResume(e)
{
    // This is called when the receiving client asks us to resume the transfer
    // from a given point.
    this.state.getResume();
    this.resumingAt = e.resumeAt;

    // Determine if quotes need to be added to the filename we pass
    var needQuotes = "";
    if (/\s/.test(this.filename))
        needQuotes = '"';

    // Tell the other end that we received and understood the RESUME request
    // (And no, mIRC doesn't check if the file being offered is smaller than
    // the requested resume-at point, either.)
    this.user.netUser.ctcp("DCC", "ACCEPT " +
                           needQuotes + this.filename + needQuotes + " " +
                           this.port + " " + e.resumeAt);

    // Pass over to the base user.
    e.destObject = this.user.netUser;
}

// Event to handle a request from the target user.
// CIRCUser points the event here.
CIRCDCCFileTransfer.prototype.onGotRequest =
function dfile_onGotRequest(e)
{
    this.state.getRequest();
    this.parent.abortReplaced(this.remoteIP, this.port, this);

    // Pass over to the base user.
    e.destObject = this.user.netUser;
}

// Event to handle a client connecting to the listening socket.
// CBSConnection points the event here.
CIRCDCCFileTransfer.prototype.onSocketAccepted =
function dfile_onSocketAccepted(socket, transport)
{
    this.state.getAccept();

    this.connection.accept(transport, null);

    this.state.socketConnected();

    // This should only happen if someone else intentionally
    // sends a bad (i.e. too large) resuming point.
    if (("resumingAt" in this) && (this.resumingAt >= this.size))
        return this.abort();

    this.position = 0;
    this.ackPosition = 0;
    this.remoteIP = transport.host;

    this.eventPump.addEvent(new CEvent("dcc-file", "connect",
                                       this, "onConnect"));

    try {
        this.filestream = Components.classes["@mozilla.org/binaryinputstream;1"];
        this.filestream = this.filestream.createInstance(nsIBinaryInputStream);
        this.filestream.setInputStream(this.localFile.baseInputStream);

        // Start the reading!
        var d;

        if ("resumingAt" in this)
        {
            // Skip the bytes we're to start after
            // This would be much easier if we could seek in the file.
            var toRead = this.resumingAt;
            while (toRead >= this.parent.sendChunk)
            {
                d = this.filestream.readBytes(this.parent.sendChunk);
                toRead -= this.parent.sendChunk;
            }
            if (toRead > 0)
                d = this.filestream.readBytes(toRead);

            this.position = this.resumingAt;
            this.ackPosition = this.position;
            delete this.resumingAt;
        }

        var available = this.size - this.position;
        if (this.parent.sendChunk > available)
            d = this.filestream.readBytes(available);
        else
            d = this.filestream.readBytes(this.parent.sendChunk);
        this.position += d.length;
        this.connection.sendData(d);
    }
    catch(ex)
    {
        dd(ex);
    }

    // Start the reading!
    if (jsenv.HAS_NSPR_EVENTQ)
        this.connection.startAsyncRead(this);
    else
        this.eventPump.addEvent(new CEvent("dcc-file", "poll", this, "onPoll"));
}

CIRCDCCFileTransfer.prototype.onPoll =
function dfile_poll (e)
{
    var data = "";
    var ev;

    try
    {
        data = this.connection.readData (this.READ_TIMEOUT);
    }
    catch (ex)
    {
        if (typeof (ex) != "undefined")
        {
            this.connection.disconnect();
            ev = new CEvent("dcc-file", "close", this, "onClose");
            ev.reason = "read-error";
            ev.exception = ex;
            this.eventPump.addEvent(ev);
            return false;
        }
        else
            data = "";
    }

    this.eventPump.addEvent(new CEvent("dcc-file", "poll", this, "onPoll"));

    if (data == "")
        return false;

    ev = new CEvent("dcc-file", "data-available", this, "onDataAvailable");
    ev.data = data;
    this.eventPump.routeEvent(ev);

    return true;
}

CIRCDCCFileTransfer.prototype.onStreamDataAvailable =
function dfile_sda(request, inStream, sourceOffset, count)
{
    var ev = new CEvent("dcc-file", "data-available", this, "onDataAvailable");
    ev.data = this.connection.readData(0, count);
    this.eventPump.routeEvent(ev);
}

CIRCDCCFileTransfer.prototype.onStreamClose =
function dfile_sockdiscon(status)
{
    if (this.position != this.size)
        this.state.failed();
    else
        this.state.socketDisconnected();
    this.dispose();
}

CIRCDCCFileTransfer.prototype.onDataAvailable =
function dfile_dataavailable(e)
{
    e.type = "rawdata";
    e.destMethod = "onRawData";

    try
    {
        if (this.state.dir == DCC_DIR_SENDING)
        {
            while (e.data.length >= 4)
            {
                var word = e.data.substr(0, 4);
                e.data = e.data.substr(4, e.data.length - 4);
                var pos = word.charCodeAt(0) * 0x01000000
                        + word.charCodeAt(1) * 0x00010000
                        + word.charCodeAt(2) * 0x00000100
                        + word.charCodeAt(3) * 0x00000001;
                this.ackPosition = pos;
            }

            while (this.position <= this.ackPosition + this.parent.maxUnAcked)
            {
                var d;
                if (this.position + this.parent.sendChunk > this.size)
                    d = this.filestream.readBytes(this.size - this.position);
                else
                    d = this.filestream.readBytes(this.parent.sendChunk);

                this.position += d.length;
                this.connection.sendData(d);

                if (this.position >= this.size)
                {
                    this.dispose();
                    break;
                }
            }
        }
        else if (this.state.dir == DCC_DIR_GETTING)
        {
            try {
                this.filestream.writeBytes(e.data, e.data.length);
            }
            catch (ex)
            {
                if (! /NS_ERROR_FILE_NO_DEVICE_SPACE/.test(ex))
                    throw ex;
                var ev = new CEvent("dcc-file", "no-device-space", this,
                                    "onNoDeviceSpace");
                ev.sourceEvent = e;
                this.eventPump.routeEvent(ev);
                this.abort();
                return true;
            }

            // Send back ack data.
            this.position += e.data.length;
            var bytes = new Array();
            for (var i = 0; i < 4; i++)
                bytes.push(Math.floor(this.position / Math.pow(256, i)) & 255);

            this.connection.sendData(String.fromCharCode(bytes[3], bytes[2],
                                                         bytes[1], bytes[0]));

            if (this.size && (this.position >= this.size))
                this.disconnect();
        }
        this.eventPump.addEvent(new CEvent("dcc-file", "progress",
                                           this, "onProgress"));
    }
    catch(ex)
    {
        this.disconnect();
    }

    return true;
}

CIRCDCCFileTransfer.prototype.sendData =
function dfile_say(data)
{
    this.connection.sendData(data);
}

CIRCDCCFileTransfer.prototype.size = 0;
CIRCDCCFileTransfer.prototype.position = 0;
CIRCDCCFileTransfer.prototype.__defineGetter__("progress",
    function dfile_get_progress()
    {
        if (this.size > 0)
            return Math.floor(100 * this.position / this.size);
        return 0;
    });

