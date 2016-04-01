var app = require('express')();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var fs = require('fs');
var dateFormat = require('dateformat');

app.get('/', function(req, res){
  console.log('get /');
  res.sendFile(__dirname + '/public/index.html');
});
function returnPublicFile(req, res) {
  var url = require('url').parse(req.url);
  console.log('get ' + req.url + ' -> ' + url.pathname);
  res.sendFile(__dirname + '/public' + url.pathname);
};
app.get('/vendor/*', returnPublicFile);
app.get('/css/*.css', returnPublicFile);
app.get('/js/*', returnPublicFile);
app.get('/partials/*', returnPublicFile);
app.get('/edit/*', function(req, res) {
  console.log('get '+req.url+' -> editor.html');
  res.sendFile(__dirname+'/public/editor.html');
});
var EXPERIENCES_DIR = __dirname+'/experiences/';
app.get('/experiences/', function(req,res) {
	console.log('get experiences');
	fs.readdir(EXPERIENCES_DIR, function(err,fnames) {
		if (err) {
			res.status(500).send('Could not read experiences directory ('+err+')');
			return;
		}
		var resp = {};
		for (var ni in fnames) {
			var fname = fnames[ni];
			var m = /^(.*\.json)(.([0-9]+))?$/.exec(fname);
			if (m!==null) {
				var name = m[1];
				var time = m[3];
				var experience = resp[name];
				if (experience===undefined)
					resp[name] = experience = {versions:[]};
				if (time===undefined) {
					try {
						var info = fs.statSync(EXPERIENCES_DIR+name);
						experience.lastmodified = info.mtime.getTime();
					} catch (err) {
						console.log('Error stat '+name+': '+err);
					}
				} else {
					experience.versions.push(time);
				}
			}
		}
		res.set('Content-Type', 'application/json').send(JSON.stringify(resp));
	});
});
app.get('/experiences/:experience', function(req,res) {
	console.log('get experience '+req.params.experience);
	res.sendFile(EXPERIENCES_DIR+req.params.experience);
});
app.get('/experiences/:experience/:version', function(req,res) {
	console.log('get experience '+req.params.experience+' version '+req.params.version);
	res.sendFile(EXPERIENCES_DIR+req.params.experience+'.'+req.params.version);
});
app.use(require('body-parser').json());
app.use(require('body-parser').urlencoded({ extended: true })); 

app.put('/experiences/:experience', function(req,res) {
	console.log('put experience '+req.params.experience);
	// rename old version using last modified?
	var filename = EXPERIENCES_DIR+req.params.experience;
	if (fs.existsSync(filename)) {
		try {
			var info = fs.statSync(filename);
			var newfilename = filename+'.'+info.mtime.getTime();
			console.log('Move '+filename+' to '+newfilename);
			try {
				fs.renameSync(filename, newfilename);
			} catch (err) {
				console.log('Error moving '+filename+' to '+newfilename+': '+err);
				res.status(500).send('Error moving '+filename+' to '+newfilename+': '+err);
				return;
			}
		} catch (err) {
			console.log('Error stat (on save) '+filename+': '+err);
			res.status(500).send('Error stat (on save) '+filename+': '+err);
			return;
		}
	}
	console.log('write '+filename);
	fs.writeFile(filename, JSON.stringify(req.body), function(err) {
		if (err) {
			console.log('error writing '+filename+': '+err);
			res.status(500).send('Error writing file: '+err);
			return;
		}
		res.sendStatus(200);
	});
});
app.get('/*.(js|json|html)', returnPublicFile);

function escapeHTML(html) {
    return String(html)
    .replace(/&(?!\w+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function run_process(cmd, args, cwd, timeout, cont) {
	console.log('spawn '+cmd+' '+args.join(' '));
	var output = [];
	var process = require('child_process').spawn(cmd,
			args, {
		cwd: cwd
	});
	process.stdin.on('error', function() {});
	process.stdout.on('data', function(data) {
		//console.log( 'Client stdout: '+data);
		output.push(data);
	});
	process.stdout.on('end', function() {});
	process.stdout.on('error', function() {});
	process.stderr.on('data', function(data) {
		output.push('Error: '+data);
	});
	process.stderr.on('end', function() {});
	process.stderr.on('error', function() {});
	process.on('close', function(code) {
		console.log('process '+cmd+' exited ('+code+')');
		cont(code, output.join(''));
	});
	console.log('done spawn');
}
var DEFAULT_TIMEOUT = 30000;

function send_status(res, status, out) {
	// commit: git log --pretty=format:%H -1
	run_process('git',['status'], __dirname+'/..',DEFAULT_TIMEOUT,function(code,output) {
		console.log('git status -> '+code+': '+output);
		out += '<h1>Musiccode Update</h1>';
		if (code!==0) {
			status = 500;
			out += '<p>Git status ERROR:</p><pre>'+escapeHTML(output)+'</pre>';
		} else {
			var m = new RegExp('^(On branch |HEAD detached at )(\\S+)').exec(output);
			if (m!==null) {
				out += '<p>Git at '+m[2]+'</p>';
			} else {
				out += '<p>Git status:</p><pre>'+escapeHTML(output)+'</pre>';
			}
		}
		run_process('git',['log','--pretty=format:%H','-1'], __dirname+'/..',DEFAULT_TIMEOUT,function(code,output) {
			if (code!==0) {
				status = 500;
				out += '<p>Git log ERROR:</p><pre>'+escapeHTML(output)+'</pre>';
			} else {
				out += '<p>Commit '+output+'</p>';
			}
			out += '<hr><form action="/update" method="POST"><label>Version: <input type="text" name="tag"><input type="submit" value="Update"></form>'
			res.status(status);
			res.send(out);
		});
	});
	console.log('waiting...');
};
app.get('/update', function(req,res) {
	console.log('/update ...');
	send_status(res,200,'');
});
app.post('/update', function(req,res) {
	//console.log(req.body);
	var tag = req.body.tag;
	console.log('update to '+tag);
	if (tag===undefined || tag=="") {
		send_status(res, 200, '<p>No tag specified</p>');
		return;
	}
	var out = '<p>tag: '+escapeHTML(tag)+' specified</p>';
	run_process('git',['fetch'],__dirname+'/..',DEFAULT_TIMEOUT,function(code,output) {
		console.log('git fetch -> '+code+': '+output);
		if (code!==0) {
			out += '<p>Warning: git fetch failed:</p><pre>'+escapeHTML(output)+'</pre>';
		} else {
			out += '<p>git fetch ok</p>';
		}
		run_process('git',['checkout',tag],__dirname+'/..',DEFAULT_TIMEOUT,function(code,output) {
			console.log('git checkout '+tag+' -> '+code+': '+output);
			var status = 200;
			if (code!==0) {
				out += '<p>Warning: git checkout '+tag+' failed:</p><pre>'+escapeHTML(output)+'</pre>';
				status = 500;
			} else {
				out += '<p>git checkout '+tag+' ok</p>';
			}
			setTimeout(function() {
				console.log('Restart...');
				var child = require('child_process').spawn('sudo',['service','musiccodes','restart'],
						{detached:true, stdio:['ignore','ignore','ignore']});
				child.unref();
			},2000);
			out += '<p>Restarting in 2 seconds</p>';
			send_status(res, status, out+'<hr>');				
		});
	});
	
});
var STATE_WAITING_FOR_PARAMETERS = 1;
var STATE_WAITING_FOR_HEADER = 2;
var STATE_RUNNING = 3;
var STATE_ERROR = 4;

var LEVEL_DEBUG = 2;
var LEVEL_INFO = 4;
var LEVEL_WARN = 6;
var LEVEL_ERROR = 8;
var LEVEL_SEVERE = 10;

var LOG_FILENAME_DATE_FORMAT = "yyyymmdd'T'HHMMssl'Z'";
var LOG_DATE_FORMAT = "yyyy-mm-dd'T'HH:MM:ss.l'Z'";
var rooms = {};
var roomLogs = {};
var LOG_DIR = __dirname+'/logs';
if (!fs.existsSync(LOG_DIR)) {
	console.log('Try to create log dir '+LOG_DIR);
	fs.mkdirSync(LOG_DIR);
	if (!fs.existsSync(LOG_DIR)) {
		console.log('ERROR: could not create log dir '+LOG_DIR);
	} else {
		console.log('Created log dir '+LOG_DIR);		
	}
}

var packageInfo = null;
try {
	var json = fs.readFileSync(__dirname+'/package.json','utf8');
	packageInfo = JSON.parse(json);
}
catch (err) {
	console.log("Error reading/parsing package info from "+__dirname+'/package.json: '+err.message);
}
var appCommit = null;
run_process('git',['log','--pretty=format:%H','-1'], __dirname+'/..',DEFAULT_TIMEOUT,function(code,output) {
	if (code!==0) {
		console.log('Could not get git commit');
	} else {
		appCommit = output.trim();
		console.log('git commit = '+appCommit);
	}
});
var installId = null;
try {
	fs.accessSync(__dirname+'/installId', fs.R_OK);
	installId = fs.readFileSync(__dirname+'/installId','utf8').trim();
} catch (err) {
	console.log('Error reading '+__dirname+'/installId: '+err.message);
}
if (installId===null) {
	var uuid = require('uuid');
	installId = uuid.v1();
	console.log('Generated installId '+installId);
	try {
		fs.writeFileSync(__dirname+'/installId', installId, 'utf8');
	} catch (err) {
		console.log('Error: could not write installId: '+err.message);
	}
}
var machineNickname = null;
try {
	fs.accessSync(__dirname+'/machineNickname', fs.R_OK);
	installId = fs.readFileSync(__dirname+'/machineNickname','utf8').trim();
} catch (err) {
	console.log('Error reading '+__dirname+'/machineNickname: '+err.message);
}
function roomJoin(room, id, masterFlag) {
	var l = roomLogs[room];
	if (l===undefined) {
		roomLogs[room] = l = { masters:[], slaves: [], recordAudio: false, entries: [] };
		var now = new Date();
		l.path = LOG_DIR+'/'+dateFormat(now, LOG_FILENAME_DATE_FORMAT)+'-'+room+'.log';
/*		try {
			roomLogs[room].log = fs.openSync(path, 'a+');
		} catch (err) {
			console.log('Error opening log file '+path+': '+err);
		}
*/
		var info = {
			logVersion: '1.0'
		};
		if (packageInfo!==null) {
			info.application = packageInfo.name;
			info.version = packageInfo.version;
		} else {
			info.application = "musiccodes-server";
			// version ?!
		}
		// installId, machineNickname, appCommit
		if (appCommit!==null)
			info.appCommit = appCommit;
		if (installId!==null)
			info.installId = installId;
		if (machineNickname!==null)
			info.machineNickname = machineNickname;
		log(room, 'server', 'log.start', info, LEVEL_INFO);
	}
	if (masterFlag && !l.masters.indexOf(id)>=0) {
		l.masters.push(id);
	}
	else if (!masterFlag && !l.slaves.indexOf(id)>=0) {
		l.slaves.push(id);
	}
}
function roomLeave(room, id) {
	var l = roomLogs[room];
	if (l!==undefined) {		
		if (l.masters.indexOf(id)>=0) {
			l.masters.splice(l.masters.indexOf(id), 1);
			console.log('remove master '+id+', leaves '+l.masters.length+'+'+l.slaves.length);
		}
		else if (l.slaves.indexOf(id)>=0) {
			l.slaves.splice(l.slaves.indexOf(id), 1);
			console.log('remove slave '+id+', leaves '+l.masters.length+'+'+l.slaves.length);
		}
		if (l.masters.length==0 && l.slaves.length==0 && l.log!==undefined) {
			log(room, 'server', 'log.end', {});
			console.log('close log '+l.path);
			l.log.end();
			delete l.out;
			delete roomLogs[room];
		} else if (l.masters.length==0) {
			delete l.logUse;
		}
	}
}
function roomLogUse(room, logUse) {
	var log = roomLogs[room];
	if (log!==undefined) {
		log.logUse = logUse;
		if (logUse==false) {
			log.entries = [];
		} else {
			try {
				console.log('create log file '+log.path);
				log.log = fs.createWriteStream(log.path, {flags:'a+',defaultEncoding:'utf8',autoClose:true,mode:0o644});
			} catch (err) {
				console.log('Error creating log file '+log.path+': '+err.message);
			}
			if (log.log!==undefined) {
				for (var ei in log.entries) {
					log.log.write(JSON.stringify(log.entries[ei]));
					log.log.write('\n');
				}
				log.entries = [];
			}
		}
	}
}
function log(room, component, event, info, level) {
	var log = roomLogs[room];
	if (log!==undefined) {
		if (log.logUse===false) 
			// discard
			return;
		if (level===undefined)
			level = LEVEL_INFO;
		var now = new Date();
		var entry = {
				time: now.getTime(),
				datetime: dateFormat(now, LOG_DATE_FORMAT),
				level: level,
				component: component,
				event: event,
				info: info
		};
		if (log.logUse===undefined || log.log===undefined) {
			// save for later
			log.entries.push(entry);
		} else {
			log.log.write(JSON.stringify(entry));
			log.log.write('\n');
		}
	}
}

function Client(socket) {
  this.socket = socket;
  console.log('New client');
  var self = this;
  // test write file spawn('dd', ['of=tmp.wav']
  // Note: this requires my modified version of the vamp plugin host,
  // https://github.com/cgreenhalgh/vamp-live
  // Here, i'm using the silvet note transcription plugin.
  // Parameter mode = 0 means fast and low quality
  // Output 2 means not on/offset
  // e.g.
/*
 0.720000000: 174.614 6 F3
 0.860000000: 174.614 0 F3 off
 0.780000000: 123.471 4 B2
 0.800000000: 293.665 5 D4
 0.860000000: 1174.66 3 D6
 0.980000000: 1174.66 0 D6 off
 1.200000000: 293.665 0 D4 off
*/
  this.state = STATE_WAITING_FOR_PARAMETERS;
  socket.on('disconnect', function(){
    self.disconnect();
  });
  socket.on('master', function(msg) {
    self.onMaster(msg);
  });
  socket.on('slave', function(msg) {
    self.onSlave(msg);
  });
  socket.on('action', function(msg) {
    self.action(msg);
  });
  socket.on('parameters', function(msg) {
    self.parameters(msg);
  });
  socket.on('audioHeader', function(msg) {
	    self.header(msg);
	  });
  socket.on('audioData', function(msg) {
  self.data(msg);
  });
  socket.on('log', function(msg) {
	  var event = msg.event;
	  if (event===undefined)
		  event = 'undefined';
	  log(self.room, 'client', event, msg.info, msg.level);
  });
}
Client.prototype.parameters = function(parameters) {
  var self = this;
  log(this.room, 'server', 'audio.parameters', parameters);
  this.state = STATE_WAITING_FOR_HEADER;
  var args = ['silvet:silvet','-','2'];
  for (var pname in parameters) {
	  var pvalue = parameters[pname];
	  args.push('-p');
	  args.push(String(pname));
	  args.push(String(pvalue));
  }
  console.log('Got parameters, running with '+args);
  // instrument 0 various, 2 guitar, 7 flute, 13 wind ensemble
  this.process = require('child_process').spawn('vamp-live-host',
    args, {
  });
  this.process.on('close', function(code) {
    console.log( 'Client process exited with code '+code );
    self.process = null;
  });
  this.process.stdin.on('error', function() {});
  this.process.stdout.on('data', function(data) {
    //console.log( 'Client stdout: '+data);
    self.processSilvetOnoffset(data);    
  });
  this.process.stdout.on('end', function() {});
  this.process.stdout.on('error', function() {});
  this.process.stderr.on('data', function(data) {
    console.log( 'Client stderr: '+data);
  });
  this.process.stderr.on('end', function() {});
  this.process.stderr.on('error', function() {});
}
Client.prototype.disconnect = function() {
  console.log('Client disconnected, master='+this.master+', room='+this.room);
  if (this.room!==null && this.room!==undefined) {
	  if (this.master)
		  log(this.room, 'server', 'master.disconnect', {id:this.socket.id, room:this.room});
	  else
		  log(this.room, 'server', 'slave.disconnect', {id:this.socket.id, room:this.room});
	  roomLeave(this.room, this.socket.id);
  }
  try {
    if (this.process!==null) 
      this.process.kill();
    this.process = null;
  } catch (err) {
    console.log('Error killing process: ', err);
  }
};
Client.prototype.header = function(msg) {
  console.log('Header: '+msg);
  if (this.state==STATE_WAITING_FOR_HEADER)
	  this.state = STATE_RUNNING;
  if (this.process!==null) {
    try {
      this.process.stdin.write(msg, 'base64');
    } catch (err) {
      console.log('Error writing data to plugin', err);
    }
  }
};
Client.prototype.data = function(msg) {
  if (this.state!=STATE_RUNNING) {
    console.log('Discard data - state '+this.state);
    return;
  }
  console.log('Data: '+msg.substring(0,50)+'...');
  if (this.process!==null) {
    try {
      this.process.stdin.write(msg, 'base64');
    //this.process.stdin.end();
    //this.process = null;
    } catch (err) {
      console.log('Error writing data to plugin', err);
    }
  }
};
Client.prototype.processSilvetOnoffset = function(data) {
  // e.g.  0.720000000: 174.614 6 F3
  var values = [];
  new String(data).replace(/\s*(\d+(\.\d+)?):\s*(\d+(\.\d+)?)\s+(\d+)\s(\S+)\s*(\S+)?/,
       function(m, time, t2, freq, f2, velocity, note, off) {
           values.push({time:Number(time),freq:Number(freq),velocity:Number(velocity),
                        note:note,off:(off=='off')});
       });
  for (var ix in values) {
    console.log('Get note '+JSON.stringify(values[ix]));
    log(this.room, 'server', 'audio.note', values[ix]);
    this.socket.emit('onoffset', values[ix]);
  }     
};

Client.prototype.onMaster = function(msg) {
  // room, pin
  if (msg.room===undefined) {
    console.log("Master with no room defined");
    return;
  }
  if (rooms[msg.room]===undefined) {
    console.log("New room for master "+msg.room+" with pin "+msg.pin);
    rooms[msg.room] = { pin: msg.pin };
    this.room = msg.room;
    this.master = true;
  } else if (rooms[msg.room].pin !== msg.pin) {
    console.log("Join existing room "+msg.room+" with wrong pin ("+msg.pin+")");
    this.socket.emit('join.error', 'Incorrect PIN');
  } else {
    console.log("Join existing room "+msg.room);
    this.room = msg.room;
    this.master = true;
  }
  if (this.room!==null && this.room!==undefined) {
	  roomJoin(this.room, this.socket.id, true);
	  // TODO: logUse set by experience
	  roomLogUse(this.room, true);
	  log(this.room, 'server', 'master.connect', {id:this.socket.id, room:this.room, channel:msg.channel, experience:msg.experience});
  }
};
Client.prototype.onSlave = function(msg) {
   // room
  if (msg.room===undefined) {
    console.log("Slave with no room defined");
    return;
  }
  console.log("slave joined room "+msg.room);
  this.socket.join(msg.room);
  this.slave = true;
  this.room = msg.room;
  roomJoin(this.room, this.socket.id, false);
  log(this.room, 'server', 'slave.connect', {id:this.socket.id, room:this.room, channel:msg.channel});
  if (rooms[msg.room]===undefined)
    this.socket.emit('join.warning', 'Unknown room');
};
Client.prototype.action = function(msg) {
  // marker...
  if (this.master) {
    console.log("relay action to room "+this.room+": "+msg);
    log(this.room, 'server', 'action.tiggered', msg);
    io.to(this.room).emit('action', msg);
  } else {
    console.log("discard action for non-master");
  }
};

io.on('connection', function(socket){
  var client = new Client(socket);
});

http.listen(3000, function(){
  console.log('listening on *:3000');
});
