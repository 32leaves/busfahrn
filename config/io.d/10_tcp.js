
var io_tcp  = require(__lib + 'io_tcp.js');

module.exports = function(bus, modules) {
    return new io_tcp(bus, true)(function(io) {
        io.start(9330);
        
        var marshal = function(type, time, msg) {
            return msg.command || "NULL";
        };
        var unmarshal = function(msg) {
            if(msg.hasOwnProperty("c")) {
                var parts = msg.c.split(" ");
                return parts.length == 3 ? { humidity: parseInt(parts[1].split(":")[1], 10), temperature: parseInt(parts[2].split(":")[1], 10) } : msg;
            } else {
                return msg;
            }
        };
        
        ['demo', 'hallway', 'livingroom', 'kitchen', 'bedroom'].forEach(function(node) {
            io.listen("act.senseless." + node, marshal);
            io.listen("sensor.senseless." + node, marshal);
        });
        io.listen(["act.heating.central", "sensor.heating.central"]);
        
    });
};
