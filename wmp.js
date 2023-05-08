
const net = require('net');
const CONSTANTS = require('./constants');
const WMP = require('./wmp_protocol');
const { array } = require('yargs');
const debug = require('debug')('wmp')
const clone = (items) => items.map(item => Array.isArray(item) ? clone(item) : item);


Promise.timeout = function(timeout, timeoutErrorObj, cb) {
    return Promise.race([
      cb,
      new Promise(function(resolve, reject) {
        setTimeout(function() {
          resolve(timeoutErrorObj);
        }, timeout);
      })
    ]);
  }

module.exports = {
    discover: function (timeout, callback, timedOutCallback, logger) {
        let dgram = require('dgram');

        let message = Buffer.from(WMP.DISCOVER +"\r\n");
        let client = dgram.createSocket("udp4");
        client.bind(CONSTANTS.WMP_DEFAULT_PORT);
        client.on("message", function (msg, rinfo) {
            logger.info("server got: " + msg + " from " + rinfo.address + ":" + rinfo.port);
            if (msg.indexOf(WMP.DISCOVER + ":") === 0) {
                let parts = msg.toString().substr((WMP.DISCOVER + ":").length).split(",");
                callback({
                    model: parts[0],
                    mac: parts[1],
                    ip: parts[2],
                    protocol: parts[3],
                    version: parts[4],
                    rssi: parts[5]
                });
            }
        });

        client.on("listening", function () {
            let address = client.address();
            logger.info("server listening " + address.address + ":" + address.port);
            client.setBroadcast(true);
            client.send(message, 0, message.length, CONSTANTS.WMP_DEFAULT_PORT, "255.255.255.255");
        });

        setTimeout(function () {
            client.close();
            if(timedOutCallback) {
                timedOutCallback();
            }
        }, timeout);
    },
    connect: function (device, logger) {
        let ip = device.ip;
        let port = device.port;
        let nextCallback = null;
        let client = new net.Socket();
        let mac;
        let rangeLimits = {};
        let deviceStatus = {};
        let disconnecting = false;

        client.on('data', function (data) {

            let wmpdata = parseResponseLines(data.toString());
            let wmpInfoDataArr = [];

            for (let i = 0; i < wmpdata.length; i++) {
                if (wmpdata[i].type != WMP.CHN) {

                    // info messages arrive in multiple lines so save them separately
                    if(wmpdata[i].type == WMP.INFO) {
                        wmpInfoDataArr.push(wmpdata[i]);
                    }
                    else {
                        if (nextCallback === null) {
                            console.error("Received message without callback: " + wmpdata[i])
                        } else {
                            nextCallback(wmpdata[i]);
                            nextCallback = null;
                        }
                    }
                }
                else {
                    // save local copy of current CHN message
                    if(!deviceStatus[wmpdata[i].acNum]) {deviceStatus[wmpdata[i].acNum] = {}};
                    prop = {};
                    prop[wmpdata[i].feature] = wmpdata[i].value;
                    Object.assign(deviceStatus[wmpdata[i].acNum],prop);
                }
            }

            if(wmpInfoDataArr.length > 0) {
                nextCallback(wmpInfoDataArr);
                nextCallback = null;
            }
        });

        let on = function (event, callback) {
            if (event == "update") {
                client.on('data', function (data) {
                    var wmpdata = parseResponseLines(data.toString())
                    for (let i = 0; i < wmpdata.length; i++) {
                        if (wmpdata[i].type == WMP.CHN) {
                            // if offMode is on post the real mode in standybymode
                            if(device.offMode && wmpdata[i].feature == WMP.MODE) {
                                wmpdata[i].stbyMode = wmpdata[i].value;
                            }                            
                            // if working in off mode mask the true mode as OFF as long as the ONOFF feature is OFF otherwise provide the real MODE
                            if(device.offMode && wmpdata[i].feature == WMP.MODE && deviceStatus[wmpdata[i].acNum][WMP.ONOFF] == WMP.OFF) {
                                wmpdata[i].value = WMP.OFF;
                            }

                            callback(wmpdata[i]);
                        }
                    }
                });
            } else if (event == 'close') {
                client.on('close', callback);
            }
        };

        function parseResponseLines(wmpString) {
            let lines = wmpString.split('\r\n');
        
            while (lines[lines.length - 1].length == 0) {
                lines.pop();
            }
        
            let rv = [];
        
            for (let i = 0; i < lines.length; i++) {
                rv.push(parseResponseLine(lines[i]))
            }
        
            return rv;
        }
        
        function parseResponseLine(wmpLine) {
            let segments = wmpLine.split(":");
            let firstChunk = segments[0].split(",");
            let type = firstChunk[0];
        
            let rv = {
                type: type
            };
        
            // if we have acNum parameter attach it to the returned values
            if(firstChunk.length == 2)
            {
                Object.assign(rv, {
                    "acNum": firstChunk[1]
                });
            }
        
            switch (type) {
                case WMP.ACK:
                    break;
                case WMP.ERR:
                    break;
                case WMP.ID:
                    var parts = segments[1].split(",");
                    Object.assign(rv, {
                        "model": parts[0],
                        "mac": parts[1],
                        "ip": parts[2],
                        "protocol": parts[3],
                        "version": parts[4],
                        "rssi": parts[5]
                    });
                    if(parts.length == 9) {
                        Object.assign(rv, {
                            "gateway name": parts[6],
                            "unknown": parts[7],
                            "platform": parts[8]
                        });
                    }
                    break;
                case WMP.LIMITS:
                    var parts = segments[1].split(",");
                    var arrParts = segments[1].split("[")[1].replace(']','').split(',');    
                    Object.assign(rv, {
                        "feature": parts[0],
                        "value": arrParts
                    })
                    break;
                default:
                    var parts = segments[1].split(",");
                    Object.assign(rv, {
                        "feature": parts[0],
                        "value": parts[1]
                    })
                    break;
            }
        
            if (rv.type === WMP.CHN)
                if (rv.feature === WMP.AMBTEMP || rv.feature === WMP.SETPTEMP)
                    rv.value = rv.value / 10;
        
            return rv;
        }

        let ping = function () {
            return sendCmd(WMP.PING)
        };

        let id = function () {
            return sendCmd(WMP.ID)
        };

        let info = function () {
            return sendCmd(WMP.INFO)
        };

        let limits = function (feature, value) {
            feature = feature.toUpperCase();
            // sanity check
            if( WMP.LIMITED_RANGES.includes(feature)) {
                    // set limits
                    if(value && Array.isArray(value)) {

                        // handle temp
                        if(feature == WMP.SETPTEMP) {
                            if(value.length == 2 && 
                                !Number.isNaN(value[0]) && 
                                !Number.isNaN(value[1]) &&
                                value[0]*10 >= WMP.ALLOWED_LIMITS[feature][0] && value[0]*10 <= WMP.ALLOWED_LIMITS[feature][1] &&
                                value[1]*10 >= WMP.ALLOWED_LIMITS[feature][0] && value[1]*10 <= WMP.ALLOWED_LIMITS[feature][1]
                                ) {
                                // adjust for Intesis
                                value[0] = value[0] * 10;
                                value[1] = value[1] * 10;
                            }
                            else {
                                logger.warn("Device " + mac + " trying to set SETPTEMP limits outside of bounds, got " + JSON.stringify(value) +  ", ignoring.")
                                return;
                            }
                        }
                        // handle the other modes
                        else {
                            let valid = true;
                            value.map( x => { valid = valid & WMP.ALLOWED_LIMITS[feature].includes(x) })
                            
                            if(rangeLimits[feature].type == CONSTANTS.INTESIS_DISABLED) {
                                logger.warn("Device " + mac + " cannot set limits for disabled feature " + feature);
                                return;
                            }
                            else if(!valid) {
                                logger.warn("Device " + mac + " trying to set " + feature + " limits to out of range values, allowed options are " + WMP.ALLOWED_LIMITS[feature].join(','))
                                return;
                            }
                        }
                        
                        // send limits command with value
                        let cmd = WMP.LIMITS + ":" + feature + ",[" + value.join(',') + "]";
                        Promise.timeout(5000, {error : "WMP TIMEOUT", cmd : cmd}, sendCmd(cmd)).then(function (data) {
                            if(data && data.hasOwnProperty('error')) {
                                logger.error("Device " + mac + " WMP failure: " + limitData.error + " command: " + limitData.cmd)
                            }
                            else {
                                // if success update our internal object to the new limit
                                rangeLimits[feature].value = value;
                                logger.log("Device " + mac + " set limit for " + feature + " to " + value.join(','));
                            }

                        });
                    }

                    // or get them if no value
                    else {
                        return sendCmd(WMP.LIMITS + ":" + feature);
                    }
                }
        }

        let get = function (feature, acNum) {
            feature = feature.toUpperCase();
            // sanity check
            if (WMP.ALLOWED_GET_COMMANDS.includes(feature) ||
            (device.offMode && feature == CONSTANTS.MQTT_INTESIS_STANDBY_MODE)) {
                if(acNum > 0 && acNum <= device.units.length) {
                    if((device.offMode && feature == CONSTANTS.MQTT_INTESIS_STANDBY_MODE)) { feature = WMP.MODE};
                    sendCmd(WMP.GET + "," + acNum + ":" + feature);
                } 
                else {
                    logger.warn("Device " + mac + " received GET command for feature " + feature + " with incorrect ac number " + acNum );
                }          
            }
            else {
                logger.warn("Device " + mac + " received incorrect GET command for unsupported feature " + feature );
            }
        };

        let set = function (feature, acNum, value) {
            let standByMode = false;
            feature = feature.toUpperCase();
             // sanity check
             if (WMP.ALLOWED_SET_COMMANDS.includes(feature) ||
             (device.offMode && feature == CONSTANTS.MQTT_INTESIS_STANDBY_MODE)) {
                if( acNum > 0 && acNum <= device.units.length) {
                    if((device.offMode && feature == CONSTANTS.MQTT_INTESIS_STANDBY_MODE)) { 
                        feature = WMP.MODE;
                        standByMode = true;
                    };
                    if (feature == WMP.SETPTEMP) {
                        //convert decimal to 10x temp numbers
                        value = value * 10;

                        let min, max;
                        max = Math.max(rangeLimits[feature].value[0],rangeLimits[feature].value[1]);
                        min = Math.min(rangeLimits[feature].value[0],rangeLimits[feature].value[1]);

                        if (value < min || value > max) {
                            logger.warn("Device " + mac + " tried SET " + feature + " to " + value/10 + " but allowed range is between " + min/10 + " and " + max/10);
                            return;
                        }
                    }
                    else {
                        value = value.toString().toUpperCase();
                        // skip check for off mode case since off is not a real valid mode for intesis
                        if(!(device.offMode && feature == WMP.MODE && value == WMP.OFF)) {
                            
                            if(rangeLimits[feature].type == CONSTANTS.INTESIS_DISABLED) {
                                logger.warn("Device " + mac + " tried SET " + feature + " to " + value + " but feature is disabled in Intesis");
                                return;
                            }
                            if(!rangeLimits[feature].value.includes(value)) {
                                logger.warn("Device " + mac + " tried SET " + feature + " to " + value + " but allowed values are: " + rangeLimits[feature].value.join(','));
                                return;
                            }
                        }
                    }

                    // if we are working in off mode we need to make sure an ON command is sent if the set command changed to any mode beside OFF
                    if(feature == WMP.MODE && device.offMode && !standByMode) {
                        if(value == WMP.OFF) {
                            sendCmd(WMP.SET + "," + acNum + ":" + WMP.ONOFF + "," + WMP.OFF).then(function (data) {
                                if (data.type != WMP.ACK) {
                                    logger.error("Device " + mac + " received non-ack message from ONOFF set command: " + JSON.stringify(data))
                                }
                                // if success force a refresh
                                else {
                                    sendCmd(WMP.GET + "," + acNum + ":" + feature);
                                }
                            });   
                        }
                        else { // we are switch mode and turning on
                            // first send the mode command to switch modes then send the on command
                            sendCmd(WMP.SET + "," + acNum + ":" + feature + "," + value).then(function (data) {
                                if (data.type != WMP.ACK) {
                                    logger.error("Device " + mac + " received non-ack message from set command: " + JSON.stringify(data))
                                }
                                else {
                                    sendCmd(WMP.SET + "," + acNum + ":" + WMP.ONOFF + "," + WMP.ON).then(function (data) {
                                        if (data.type != WMP.ACK) {
                                            logger.error("Device " + mac + " received non-ack message from ONOFF set command: " + JSON.stringify(data))
                                        }
                                        // if success force a refresh
                                        else {
                                            sendCmd(WMP.GET + "," + acNum + ":" + feature);
                                        }
                                    });
                                }
                            });  
                        }
                    }
                    // regular mode without off mode
                    else {
                        sendCmd(WMP.SET + "," + acNum + ":" + feature + "," + value).then(function (data) {
                            if (data.type != WMP.ACK) {
                                logger.error("Device " + mac + " received non-ack message from set command: " + JSON.stringify(data))
                            }
                        });    
                    }
                } 
                else {
                    logger.warn("Device " + mac + " received SET command for feature " + feature + " with incorrect ac number " + acNum );
                }   
            }  
            else {
                logger.warn("Device " + mac + " received incorrect SET command for unsupported feature " + feature );
            }         
        };

        let sendCmd = function (cmd) {
            return new Promise(function (resolve, reject) {
                nextCallback = resolve;
                client.write(cmd + '\n');
            })
        };

        let disconnect = function () {
            logger.info("Device" + mac + " WMP client disconnecting.")
            disconnecting = true;
            client.destroy();
        }

        // handle client connection errors
        client.on('error', function(err) {
            switch (err.code) {
                case "ETIMEDOUT":
                    logger.error("Connection timed out with ip " + device.ip + " ,please check the device is online at the ip address.");
                    break;
                case "ENOTFOUND":
                    logger.error("No device found at address " + device.ip);
                    break;
                case "ECONNREFUSED":
                    logger.error("Connection refused at " + device.ip + " ,please check the IP.");
                    break;
                default:
                    logger.error("Connection error code " + err.code + " at " + device.ip );
                    break;
            }
        })

        // initalize the Intesis limits
        function initLimits(features) {
            limitsData = {};
            return _limits(features, limitsData);
          
            function _limits(features, limitsData) {
              if (features.length == 0) {
                return Promise.resolve(limitsData);
              }
          
              return new Promise(function(resolve, reject) {
                
                Promise.timeout(5000, {error : "WMP TIMEOUT", cmd : WMP.LIMITS+":"+features[0]}, limits(features[0])).then(function(limitData) {
                    if(limitData.error) {
                        logger.error("Device " + mac + " WMP failure: " + limitData.error + " command: " + limitData.cmd)
                    }
                    else {
                        let message = "Device " + mac + " got limits for: " + limitData.feature + " with range: " + limitData.value.join(',');
                        if(limitData.value == '') {
                            // limits that are initially read as '' are considered not available to control by the gateway
                            message = "Device " + mac + " got empty limits for " + limitData.feature + " disabling feature."
                            limitData = {type: CONSTANTS.INTESIS_DISABLED}   
                        } 

                        logger.info(message);
                        limitsData[features[0]] = limitData;
                    }
                    features.shift();
                    resolve(_limits(features, limitsData));
                });
              });
            }
          }

          return new Promise(function (resolve, reject) {
            client.connect(port, ip, function () {
                id().then(function (data) {
                    mac = data.mac;
                    initLimits(clone(WMP.LIMITED_RANGES)).then(function(limitData) {
                        rangeLimits = limitData;
                        resolve({
                            on: on,
                            ping: ping,
                            id: id,
                            info: info,
                            get: get,
                            set: set,
                            limits: limits,
                            disconnect: disconnect,
                            mac: mac,
                            device: device,
                            logger: logger,
                            rangeLimits: rangeLimits,
                            deviceStatus : deviceStatus,
                            disconnecting: disconnecting
                        });
                    });
                });
            });
        });
    }
}
