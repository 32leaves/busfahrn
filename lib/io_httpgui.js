"use strict";
var express  = require('express'),
    hbs      = require('hbs'),
    fs       = require("fs"),
    https    = require("https"),
    http     = require("http"),
    socketio = require('socket.io'),
    crypto   = require('crypto'),
    passport = require('passport'),
    BasicStrategy = require('passport-http').BasicStrategy;

function IO_HTTPGui(bus, ui_config) {
    this._app = express();
    this._bus = bus;
    this._config = ui_config;
    this._enableConsole = false;
}

IO_HTTPGui.prototype.use_authentication = function(authenticator, needsAuthentication) {
    needsAuthentication = needsAuthentication === undefined ? function(req) { return true; } : needsAuthentication;
    
    passport.use(new BasicStrategy(
        function(username, password, done) {
            if(authenticator.mayPost(username, crypto.createHmac("sha1", password).digest("hex"), "")) {
                return done(null, username);
            } else {
                return done(null, false, { message: 'Incorrect username or password.' });
            }
        }
    ));
    
    var app = this._app;
    app.use(passport.initialize());
    app.use(function(req, res, next) {
        if(needsAuthentication(req)) {
            return passport.authenticate('basic', { 'session' : false })(req, res, next);
        } else {
            return next();
        }
    });
    app.get('/logout', function(req, res) {
        req.logout();
        res.redirect('/');
    });
    
    return this;
};

IO_HTTPGui.prototype.serve = function(url_prefix, path) {
    this._app.use(url_prefix, express.static(path));
    return this;
};

IO_HTTPGui.prototype.enableConsole = function() {
    this._enableConsole = true;
    return this;
};

IO_HTTPGui.prototype.start = function(port, https) {
    var app = this._app;
    var ui_config = this._config;
    var bus = this._bus;
    var httpgui = this;
    
    app.set('view engine', 'html');
    app.engine('html', require('hbs').__express);
    app.set('views', __lib + 'aux/httpgui/templates');
    
    app.get('/', function(req, res) {
        hbs.registerHelper('type', function(whattype, options) {
            return (this.type == whattype) ? options.fn(this) : options.inverse(this);
        });
        hbs.registerHelper('func', function(func) {
            return func.toString();
        });
        
    	res.render('index.html', { 'config' : ui_config, 'enableTerminal' : httpgui._enableConsole });
    });

    app.all('/exec/:group/:id', function(req, res) {
		var grpid = req.params.group;
        var wdgid = req.params.id;
        
        for(var groupIdx in ui_config) {
            var group = ui_config[groupIdx];
            if(grpid != group.id) continue;
            
            for(var widgetIdx in group.widgets) {
                var widget = group.widgets[widgetIdx];
                if(wdgid != widget.id || widget.type !== 'action') continue;
                
                bus.post(widget.message.type, widget.message.body);
            }
        }
        
		res.send(JSON.stringify({ 'status' : 'done' }));
    });
    
    app.use('/metro', express.static(__lib + 'aux/httpgui/MetroUICSS/'));
    app.use('/knob', express.static(__lib + 'aux/httpgui/jQuery-Knob/js'));
    app.use('/terminal', express.static(__lib + 'aux/httpgui/jquery.terminal'));
    app.get('/terminal/js/jquery.terminal.busfahrn.js', function(req, res) { res.sendfile(__lib + 'aux/httpgui/jquery.terminal.busfahrn.js'); });
    app.use('/flot', express.static(__lib + 'aux/httpgui/flot'));
    app.get('/js/jquery.js', function(req, res) { res.sendfile(__lib + 'aux/httpgui/jquery.min.js'); });
    app.get('/js/jquery.timeago.js', function(req, res) { res.sendfile(__lib + 'aux/httpgui/jquery.timeago.js'); });
    
    var server;
    if(https === undefined || https) {
        var privateKey  = fs.readFileSync(__config + 'server.key').toString();
        var certificate = fs.readFileSync(__config + 'server.crt').toString();
        var credentials = {key: privateKey, cert: certificate};
        server = https.createServer(credentials, app);
    } else {
        server = http.createServer(app);
    }
    
    var io = socketio.listen(server);
    server.listen(port);
    
    io.configure(function() {
       io.disable('log'); 
    });
    
    
    var events = [];
    var displays = [];
    for(var groupIdx in this._config) {
        var group = this._config[groupIdx];
        
        (group.listeners || []).forEach(function(typeListener) {
            displays.push([typeListener.type, typeListener.type]);
        });
        
        for(var widgetIdx in group.widgets) {
            var widget = group.widgets[widgetIdx];
            if(widget.type == 'action') {
                events.push(['action' + widget.id, function(type, msg) { return function(data) {
                    bus.post(type, msg);
                }; }(widget.message.type, widget.message.body)]);
            } else if(widget.type == 'range') {
                events.push(['rangeUpdate' + widget.id, function(type) { return function(data) {
                    bus.post(type, data);
                }; }(widget.message.type) ]);
                displays.push(['rangeUpdateView' + widget.id, widget.message.type]);
            } else if(widget.type == 'display') {
                if(widget.message.hasOwnProperty("marshal")) {
                    events.push(['displayAction' + widget.id, function(type) { return function(data) {
                        bus.post(type, data);
                    }; }(widget.message.type)]);
                }
                
                displays.push(['display' + widget.id, widget.message.type]);
            } else if(widget.type == 'switches') {
                (widget.messages || []).forEach(function(swtch) {
                    swtch.id = widget.id + swtch.type.replace(/\./g, "");
                    if(swtch.hasOwnProperty("marshal")) {
                        events.push(['switchAction' + swtch.id, function(type) { return function(data) {
                            bus.post(type, data);
                        }; }(swtch.type)]);
                    }
                    if(swtch.hasOwnProperty("unmarshal")) {
                        displays.push(['switch' + swtch.id, swtch.type]);
                    }
                });
            } else if(widget.type == 'plot') {
                displays.push(['plot' + widget.id, widget.message.type, widget.message.limit || 100]);
            }
        }
    }
    
    // support notifications
    displays.push(['notification', [ 'notification.info', 'notification.warning', 'notification.error', 'notification.attention' ], 5]);
    
    // support the terminal
    if(this._enableConsole) {
        io.sockets.on('connection', function(socket) {
            var dereg = null;
            
            socket.on('io.httpgui.terminal.enable', function(data) {
                if(dereg !== null) dereg();

                dereg = bus.listen("_all", function(type, time, msg) {
                    socket.emit("io.httpgui.terminal.bus", { 'type': type, 'time': time, 'msg': msg });
                });
            });
            socket.on('io.httpgui.terminal.disable', function(data) {
                if(dereg !== null) {
                    dereg();
                    dereg = null;
                }
            });
            socket.on('io.httpgui.terminal.cmd', function(data) {
                if(data.type === null) {
                    socket.emit('io.httpgui.terminal.error', 'Message type missing');
                } else if(data.msg === null) {
                    socket.emit('io.httpgui.terminal.error', 'Message missing');
                } else {
                    bus.post(data.type, data.msg);
                }
            });
            
            socket.on('disconnect', function() {
                if(dereg !== null) {
                    dereg();
                    dereg = null;
                }
            });
        });
    }
    
    // populate new clients
    if(events.length > 0) {
        io.sockets.on('connection', function (socket) {
            for(var eventIdx in events) {
                var event = events[eventIdx];
                socket.on(event[0], event[1]);
            }
        });
    }
    // keep clients up to date
    if(displays.length > 0) {
        io.sockets.on('connection', function (socket) {
            var dereg = displays.map(function(disp) {
                return bus.listen(disp[1], function(type, time, msg) {
                    socket.emit(disp[0], { 'type': type, 'time': time, 'msg': msg });
                });
            });

            socket.on('disconnect', function() {
                dereg.forEach(function(deregisterListener) {
                    deregisterListener(); 
                });
                bus.post("io.httpgui.disconnect", { listenerCount: bus._totalListeners });
            });
            
            bus.post("io.httpgui.connect", { listenerCount: bus._totalListeners });
            
            displays.forEach(function(disp) {
                if(!(disp[1] instanceof Array)) {
                    disp[1] = [ disp[1] ];
                }
                
                disp[1].forEach(function(msgtype) {
                    bus.peek('inspection.latest.' + msgtype, function(type, time, msg) {
                        if(msg.length == 1 && msg[0] !== null && msg[0] !== undefined) {
                            socket.emit(disp[0], { 'type': msgtype, 'time': msg[0].time, 'msg': msg[0].msg });
                        } else if(msg.length > 1) {
                            socket.emit(disp[0], msg.map(function(e) {
                                e.type = msgtype;
                                return e;
                            }));
                        }
                    });
                    bus.post('inspection.latest', { type: msgtype, limit: disp[2] || 1 });
                });
                
            });
        });
    }
    
    return this;
}

module.exports = IO_HTTPGui;

