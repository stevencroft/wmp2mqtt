'use strict'

const CONSTANTS = require('./constants');
const WMP = require('./wmp_protocol');
const yargs = require('yargs/yargs'); // new yargs
var winston = require('winston');
const path = require('path');

const alignColorsAndTime = winston.format.combine(
    winston.format.colorize({
      all: true,
    }),
    winston.format.label({
      label: "[LOG]",
    }),
    winston.format.timestamp({
      format: "DD/MM/YYYY HH:mm:ss",
    }),
    winston.format.printf(
      (info) => `${info.label} ${info.timestamp} ${info.level} : ${info.message}`
    )
  );

const alignAndTime = winston.format.combine(
winston.format.label({
    label: "[LOG]",
}),
winston.format.timestamp({
    format: "DD/MM/YYYY HH:mm:ss",
}),
winston.format.printf(
    (info) => `${info.timestamp} ${info.level} : ${info.message}`
)
);

const transports = {
    console: new winston.transports.Console({ 
        format: winston.format.combine(
            winston.format.colorize(),
            alignColorsAndTime
            ),
        level: 'debug'
        }),
    file: new winston.transports.File({ 
        dirname: `${__dirname}/log`,
        filename: 'wmp2mqtt.log', 
        level: 'debug',
        format: alignAndTime
    })
  };

const logger = winston.createLogger({
    transports: [
        transports.console,
        transports.file
    ]
});

const fs = require('fs')

var config = {};
logger.info("!------------------------WMP2MQTT started!-----------------------!");

// try loading config.js supporting new features
const configPath = process.env.CONFIG_PATH || './settings.js';
try {
    //19122025 if (fs.existsSync('./config/config.js')) {
    //if (fs.existsSync(argv.configfile)) {
    if (fs.existsSync(configPath)) {
        config = require(configPath);
        //19122025 config = require('./config/config');
        //config = require(argv.configfile);
        transports.console.level = config.logs.levels.console;
        transports.file.level = config.logs.levels.console;
        logger.info("Config.js found and loaded, ignoring args.");
    }
    else
    {
        logger.info("Config.js file not found defaulting to args method.");
        config.mqtt = {};
        config.mqtt.connection = {};
    }
  } catch(err) {
    logger.error(err)
  }

// if config file not specified default to old args method
if(!config.mqtt.connection.url)
{
    config.intesis = {};
    config.mqtt = {};
    config.mqtt.connection = {};
    config.mqtt.publish = {};
    config.mqtt.subscribe = {};

    var argv = require('yargs')
    argv = yargs(process.argv.slice(2)) // Pass process.argv correctly
    .usage(CONSTANTS.USAGE_STRING)
    .demandOption(['mqtt'])
    .option('offMode', { // Add this option
      alias: 'o',
      type: 'boolean',
      description: 'Set the off mode behavior for discovered or manually specified devices',
      default: false // Keep default as false
    })
    .argv;

    config.intesis.devices = [];
    if (argv.wmp) {
        let supplied_intesis_ips = [];
        supplied_intesis_ips = argv.wmp.split(',');
        supplied_intesis_ips.forEach(ip => config.intesis.devices.push({"type": "box", "ip": ip, "port": CONSTANTS.WMP_DEFAULT_PORT, "keepAliveMode": "id", "offMode": argv.offMode , units:[{"id": 1, "type": "IU", "description": "AC Unit"}]}));
    }

    config.intesis.discover = argv.discover;
    
    config.mqtt.connection.url = argv.mqtt.split(':')[0] + ":" + argv.mqtt.split(':')[1];
    config.mqtt.connection.port = argv.mqtt.split(':')[2];
    config.mqtt.publish.topic = CONSTANTS.MQTT_STATE_TOPIC;
    config.mqtt.publish.retain = (argv.retain === "true") ? true:false;
    config.mqtt.subscribe.topic = CONSTANTS.MQTT_COMMAND_TOPIC;
}

const mqtt = require('mqtt')
const wmp = require('./wmp');

let mqttClient = mqtt.connect(config.mqtt.connection.url + ":" + config.mqtt.connection.port, config.mqtt.connection.options)

let mqttPublish = function(mqttClient, topic, payload, retain) {
    logger.info('Sending to MQTT topic: ' + topic + ' with payload: ' + payload);
    mqttClient.publish(topic, payload, {retain:retain})
}

//todo detect connection failures
mqttClient.on('error', function (error) {
    logger.error("Error from mqtt broker: %v", error)
});
mqttClient.on('connect', function (connack) {
    logger.info("Connected to mqtt broker " + this.options.href)
    // publish on connection message if specfieid
    if(config.mqtt.connection.options.onconnection) {
        mqttPublish(mqttClient, config.mqtt.connection.options.onconnection.topic, config.mqtt.connection.options.onconnection.payload,config.mqtt.connection.options.onconnection.retain);
    }
});

let runWMP2Mqtt = function (mqttClient, wmpclient) {
    wmpclient.on('update', function (data) {
        //logger.debug('Sending to MQTT: ' + JSON.stringify(data));
        
        let mqttPublishTopic = config.mqtt.publish.topic + "/" + wmpclient.mac;

        //add support for gateways with multiple ac units by adding an additional acNum id after the mac address of the gateway
        // intesis boxes with single ac unit will keep old mqtt topic without acNum
        if(wmpclient.device.type == CONSTANTS.INTESIS_GATEWAY) {
            mqttPublishTopic += "/" + data.acNum;
        }


        mqttPublishTopic += "/settings/";
        let mqttPublishTopicStby = mqttPublishTopic + CONSTANTS.MQTT_INTESIS_STANDBY_MODE.toLowerCase();
        mqttPublishTopic += data.feature.toLowerCase();
        mqttPublish(mqttClient, mqttPublishTopic, data.value.toString().toLowerCase(), config.mqtt.publish.retain)
        // if we are in "offMode" report the true ac  mode in standby mode topic
        if(data.stbyMode) {
            mqttPublish(mqttClient, mqttPublishTopicStby, data.stbyMode.toString().toLowerCase(), config.mqtt.publish.retain)
        }
    });
}

let parseCommand = function (topic, payload) {
    // format of commands is /<topic>/<mac>/<area>/<feature> payload (for set only is value
    // added support for format /<topic>/<mac>/<acNum/><area>/<feature> where it is possible to specifiy an ac unit among many controlled by an intesis gateway
    let rv = {};
    //strip prefix and split
    let parts = topic.substr(config.mqtt.subscribe.topic.length).replace(/^\/+/g, '').split("/");

    rv['mac'] = parts[0];

    let switchParam = parts[1];
    let feature = parts[2];
    let acNum = 1;

    if(parts.length < 2 || parts.length > 4) {
        logger.error("Got incorrect MQTT command: " + topic + " payload: " + payload)
        return rv;
    }

    if(parts.length == 4) {
        feature = parts[3];
        switchParam = parts[2];
        acNum = parts[1];
    }

    switch (switchParam.toUpperCase()) {
        case CONSTANTS.MQTT_COMMAND_SETTINGS_SUFFIX:
            rv['feature'] = feature;
            rv['acNum'] = acNum;
            if (payload && payload.length > 0) {
                rv['command'] = WMP.SET;
                rv['value'] = payload;
            } else {
                rv['command'] = WMP.GET;
            }
            break;
        case CONSTANTS.MQTT_COMMAND_LIMITS_SUFFIX:
            rv['feature'] = feature;
            rv['command'] = WMP.LIMITS;
            if (payload && payload.length > 0) {
                rv['value'] = payload.toString().split(',');
            }
            break;
        case CONSTANTS.MQTT_COMMAND_ID_SUFFIX:
            rv['command'] = WMP.ID;
            break;
        case CONSTANTS.MQTT_COMMAND_INFO_SUFFIX:
            rv['command'] = WMP.INFO;
            break;
        default:
            logger.warn("Unkown MQTT command suffix received: " + switchParam);
    }
    

    return rv;
}

var runMqtt2WMP = function (mqttClient, wmpclientMap) {
    mqttClient.subscribe(config.mqtt.subscribe.topic + "/#")

    mqttClient.on('message', function (topic, message) {
        let cmd = parseCommand(topic, message);
        // select proper wmp client per message
        let wmpclient = wmpclientMap[cmd.mac];

        if (!wmpclient) {
            logger.warn("Cannot find WMP server with MAC " + cmd.mac + "! Ignoring...")
            return;
        }

        switch (cmd.command) {
            case WMP.ID:
                wmpclient.id().then(function (data) {
                    mqttPublish(mqttClient, config.mqtt.publish.topic + "/" + wmpclient.mac, JSON.stringify(data), config.mqtt.publish.retain)
                });
                break;
            case WMP.INFO:
                wmpclient.info().then(function (data) {
                    mqttPublish(mqttClient, config.mqtt.publish.topic + "/" + wmpclient.mac, JSON.stringify(data), config.mqtt.publish.retain)
                });
                break;
            case WMP.GET:
                wmpclient.get(cmd.feature, cmd.acNum);
                break;
            case WMP.SET:
                wmpclient.set(cmd.feature, cmd.acNum, cmd.value);
                break;
            case WMP.LIMITS:
                if(cmd.value) {
                    wmpclient.limits(cmd.feature, cmd.value);
                }
                else {
                    wmpclient.limits(cmd.feature).then(function (data) {
                        mqttPublish(mqttClient, config.mqtt.publish.topic + "/" + wmpclient.mac + "/" + CONSTANTS.MQTT_COMMAND_LIMITS_TOPIC + "/" + cmd.feature, JSON.stringify(data), config.mqtt.publish.retain)
                    }); 
                }
                break;
            default:
                logger.warn("Unkown MQTT command sent to MAC " + cmd.mac + "! Ignoring...") 
        }
    })

    let keepalive = setInterval(function() {
        try {
            let wmpclients = Object.keys(wmpclientMap)
            wmpclients.forEach(function(mac) {
                let wmpclient = wmpclientMap[mac];
                switch(wmpclient.device.keepAliveMode) {
                    case CONSTANTS.WMP_KEEP_ALIVE_OFF:
                        break;
                    case CONSTANTS.WMP_KEEP_ALIVE_ID:  
                        wmpclient.id().then( function(data) {
                            logger.debug("keepalive: keeping alive MAC " + mac + " by ID.")
                        });
                        break;
                    case CONSTANTS.WMP_KEEP_ALIVE_PING:
                        wmpclient.ping().then( function(data) {
                            logger.debug("keepalive: keeping alive MAC " + mac + " by PING.")
                        });
                        break;
                    case CONSTANTS.WMP_KEEP_ALIVE_POLLING:
                        logger.debug("keepalive: keeping alive MAC " + mac + " by pooling.")
                        wmpRefresh(wmpclient);
                        break;
                    default:
                        // no keep alive
                }            
            });
        } catch (err) {
            logger.warn(err);
            logger.warn("Failure in keepalive (connection dead?)");
        }
    }, CONSTANTS.WMP_KEEP_ALIVE);
}

var macToClient = {};

let wmpConnect = function (device) {
    wmp.connect(device, logger).then(function (wmpclient) {
        logger.info("Connected to WMP at IP " + device.ip + " with MAC " + wmpclient.mac + " of type " + wmpclient.device.type);
        // initially we are still offline
        mqttPublish(mqttClient, config.mqtt.publish.topic + "/" + wmpclient.mac + "/" + CONSTANTS.MQTT_INTESIS_AVAILABILITY_TOPIC_SUFFIX , CONSTANTS.MQTT_INTESIS_AVAILABILITY_PAYLOAD_OFFLINE, config.mqtt.publish.retain)

        if(device.offMode)
            logger.info("Device " + wmpclient.mac + " configured in off mode!");

        logger.info("Device " + wmpclient.mac + " keep alive configured in " + device.keepAliveMode + " mode!");

        wmpclient.readyIntervalID = undefined;

        wmpclient.on('close', function () {
            logger.warn('Device ' + wmpclient.mac + ' WMP Connection closed!');
            
            // if we encounter a disconnect while waiting for Intesis to be ready clear the setInterval put in place to check for ready
            if(wmpclient.readyIntervalID) {
                clearInterval(wmpclient.readyIntervalID);
            }
            // post our device WLT informing subscribers we are going offline
            mqttPublish(mqttClient, config.mqtt.publish.topic + "/" + wmpclient.mac + "/" + CONSTANTS.MQTT_INTESIS_AVAILABILITY_TOPIC_SUFFIX , CONSTANTS.MQTT_INTESIS_AVAILABILITY_PAYLOAD_OFFLINE, config.mqtt.publish.retain)
            
            // clear out the reference
            if(Object.is(wmpclient, macToClient[wmpclient.mac])) {
                delete macToClient[wmpclient.mac];
            }  

            // if this is not an intentional disconnect try and reestablish the connection
            if(!wmpclient.disconnecting) {
                logger.warn('Connection to ' + device.ip + ' forcefully closed, retrying within ' + CONSTANTS.WMP_RECONNECT_TIMEOUT/1000 + ' seconds.')
                
                setTimeout(function() {
                    wmpConnect(device);
                }, CONSTANTS.WMP_RECONNECT_TIMEOUT)
            }
        });

        // check if we have an existing MAC connected and if so gracefully disconnect and replace with new wmp client
        if(macToClient[wmpclient.mac]) {
            macToClient[wmpclient.mac].disconnect();
        }
        macToClient[wmpclient.mac] = wmpclient

        // query AMBTEMP & SETPTEMP features of all AC's, if they are zero this means intesis is not ready yet so wait 10 seconds and try again finally setting us to online when Intesis is ready
        wmpRefresh(wmpclient); 
        setTimeout( function() {  
            if(!wmpIsIntesisReady(wmpclient)) {   
                logger.info("Device " + wmpclient.mac + " is not ready yet, will check again in " + CONSTANTS.INTESIS_READY_TIMEOUT/1000 + " seconds.")
                wmpclient.readyIntervalID = setInterval(function() {
                if(wmpIsIntesisReady(wmpclient)) {
                        logger.info("Device " + wmpclient.mac + " finished initializing and is ready.")
                        clearInterval(wmpclient.readyIntervalID);
                        wmpFinishSetup(wmpclient);
                }
                else {
                        logger.info("Device " + wmpclient.mac + " is not ready yet, will check again in " + CONSTANTS.INTESIS_READY_TIMEOUT/1000 + " seconds.")
                }
                }, CONSTANTS.INTESIS_READY_TIMEOUT)
            }
            else {
                logger.info("Device " + wmpclient.mac + " finished initializing and is ready.")
                wmpFinishSetup(wmpclient);
            }
        }, CONSTANTS.INTESIS_READY_DELAY)
    })
};

let wmpIsIntesisReady = function(wmpclient) {
    wmpRefresh(wmpclient);
    
    if(Object.keys(wmpclient.deviceStatus).length > 0) {
        let valid = true;
        Object.keys(wmpclient.deviceStatus).map( acIdx => {
            valid = valid & wmpclient.deviceStatus[acIdx][WMP.AMBTEMP] != 0 & wmpclient.deviceStatus[acIdx][WMP.SETPTEMP] != 0;
        })
        if(valid)
            return true;
    }
    return false;
};

let wmpFinishSetup = function (wmpclient) {
    runWMP2Mqtt(mqttClient, wmpclient)
    mqttPublish(mqttClient, config.mqtt.publish.topic + "/" + wmpclient.mac + "/" + CONSTANTS.MQTT_INTESIS_AVAILABILITY_TOPIC_SUFFIX , CONSTANTS.MQTT_INTESIS_AVAILABILITY_PAYLOAD_ONLINE, config.mqtt.publish.retain)
};

let wmpRefresh = function(wmpclient) {
    wmpclient.device.units.map(unit => {
        wmpclient.get('*', unit.id);
    })  
};

config.intesis.devices.map(device => {
    wmpConnect(device);
});

let doDiscover = function() {
    wmp.discover(1000, function (data) {
        logger.info("Discovered")
        wmpConnect({"type": "box", "ip": data.ip, "port": CONSTANTS.WMP_DEFAULT_PORT, "keepAliveMode": "id", "offMode": argv.offMode, units:[{"id": 1, "type": "IU", "description": "AC Unit"}]});
    }, function(){
        if(Object.keys(macToClient).length === 0) {
            logger.info("Nothing connected, retrying discovery in " + CONSTANTS.DISCOVER_WAIT + " seconds..");
            setTimeout(doDiscover, CONSTANTS.DISCOVER_WAIT * 1000)
        } 
    }, logger);
}

if (config.intesis.discover) {
    doDiscover();
};


runMqtt2WMP(mqttClient, macToClient);