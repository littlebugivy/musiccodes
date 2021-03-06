/* midi.js - midi test... */
var midi = null;  // global MIDIAccess object
var midiInputPort = null;
var midiOutputPort = null;
var midiNoteCallback = null;
var midiSelectCallback = null;
var midiInputName = null;
var midiOutputName = null;
var midiLogCallback = null;

function setupMidi( midiIn, midiOut, noteCallback, selectCallback, logCallback ) {
	midiInputName = midiIn;
	midiOutputName = midiOut;
	midiNoteCallback = noteCallback;
	midiSelectCallback = selectCallback;
	midiLogCallback = logCallback;
	// request top-level midi access (non-exclusive)
	navigator.requestMIDIAccess().then( onMIDISuccess, onMIDIFailure );
}
	
function onMIDISuccess( midiAccess ) {
  console.log( "MIDI ready!" );
  midi = midiAccess;  // store in the global (in real usage, would probably keep in an object instance)

  listInputsAndOutputs( midiAccess );
}

function onMIDIFailure(msg) {
  console.log( "Failed to get MIDI access - " + msg );
}

function listInputsAndOutputs( midiAccess ) {
  var midiInputId = null;
  midiAccess.inputs.forEach( function( input ) {
    console.log( "Input port [type:'" + input.type + "'] id:'" + input.id +
      "' manufacturer:'" + input.manufacturer + "' name:'" + input.name +
      "' version:'" + input.version + "'" );
    $('#midiinput').append('<option value="'+input.id+'">'+input.name+'</option>')
    if (input.name==midiInputName)
      midiInputId = input.id;
  });
  if (midiInputId!==null) {
    $('#midiinput').val(midiInputId);
    selectMidiInput(midiInputId);
  }
  var midiOutputId = null;
  midiAccess.outputs.forEach( function( output ) {
    console.log( "Output port [type:'" + output.type + "'] id:'" + output.id +
      "' manufacturer:'" + output.manufacturer + "' name:'" + output.name +
      "' version:'" + output.version + "'" );
    $('#midioutput').append('<option value="'+output.id+'">'+output.name+'</option>')
    if (output.name==midiOutputName) 
      midiOutputId = output.id; 
  });
  if (midiOutputId!==null) {
    $('#midioutput').val(midiOutputId);
    selectMidiOutput(midiOutputId);
  }
}

$('#midiinput').change( function( ev ) {
  var id = $(this).val();
  selectMidiInput(id);
});
function selectMidiInput(id) {
  console.log('Select input '+id);	
  if (midiInputPort!==null) {
	  midiInputPort.close();
	  midiInputPort = null;
  }
  midiInputPort = midi.inputs.get(id);
  // monitor input...
  midiInputPort.onmidimessage = function(msg) {
	  var str = "MIDI message received at timestamp " + event.timestamp + "[" + event.data.length + " bytes]: ";
	  for (var i=0; i<event.data.length; i++) {
	    str += "0x" + event.data[i].toString(16) + " ";
	  }
	  console.log( str );
	  processMidiMessage( event.data );
  };
  if (midiLogCallback!==null)
	  midiLogCallback('midi.config.in',{id:id, name:midiInputPort.name});
  if (midiSelectCallback!==null) 
    midiSelectCallback(id);
}

function processMidiMessage( data ) {
  if (data.length<3)
	  return;
  var cmd = data[0];
  if (cmd>=0x90 && cmd<=0x9f) {
	  // note on
	  var note = data[1];
	  var vel = Number(data[2]);
	  processMidiNote(cmd, note, vel);
  }
  else if (cmd>=0x80 && cmd<=0x8f) {
	  // note off - cf note on vel = 0
	  var note = data[1];
	  processMidiNote(cmd, note, 0);	  
  }
}
var time0 = Date.now();
var notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function processMidiNote(cmd, note, vel) {
	// note 60 is middle C, which I think plugin calls C4, freq. is nominally 261.6Hz
	var name = notes[note % 12]+String(Math.floor(note / 12)-1);
	var freq = 261.6*Math.pow(2, (note-60)/12.0);
	var time = (Date.now()-time0)*0.001;
	var event = { time: time, note: name, freq: freq, velocity: vel, off: (vel==0) };
	console.log(event);
	try {
		if (midiNoteCallback!==null)
			midiNoteCallback(event);
	} catch (err) {
		console.log('midiNoteCallback error '+err);
	}
}
$('#midioutput').change( function( ev ) {
  var id = $(this).val();
  selectMidiOutput(id);
});
function selectMidiOutput(id) {
	  console.log('Select output '+id);	
	  // send a test note on / off
	  var noteOnMessage = [0x90, 60, 0x7f];    // note on, middle C, full velocity
	  midiOutputPort = midi.outputs.get(id);
	  //output.send( noteOnMessage );  //omitting the timestamp means send immediately.
	  //output.send( [0x80, 60, 0x40], window.performance.now() + 1000.0 ); // Inlined array creation- note off, middle C,  
	                                                                      // release velocity = 64, timestamp = now + 1000ms.
	  if (midiLogCallback!==null)
		  midiLogCallback('midi.config.out',{id:id, name:midiOutputPort.name});
}
// accepts message as hex string
function midiSend( hex ) {
	if (midiOutputPort===null) {
		console.log('discard midi send '+hex+' (no output)');
		return;
	}
	var message = [];
	for (var i=0; i+1<hex.length; i+=2) {
		var b = hex.substring(i,i+2);
		message.push(parseInt(b, 16));
	}
	console.log('midiSend: '+hex);
	midiOutputPort.send( message );
}
