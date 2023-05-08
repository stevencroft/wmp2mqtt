# wmp2mqtt
Bridge from Intesis WMP protocol to MQTT

This project allows bridging from Intesis WMP protocol to MQTT. WMP is used to control HVAC systems via Intesis control boxes: https://www.intesisbox.com/en/wifi/gateways/ (note 'IntesisHome' IS NOT SUPPORTED).

# Updates and changes by pazoozoo123 - MAY23
Added the following features:
1. Added support for Intesis AC gateways enabling control of multiple AC units with a single interface box, make sure the gateway is fully configured using the Intesis MAPS application.
2. Added config.js to allow extensive configuration (MQTT options and gateways additional AC units beyond 1 are only supported via config.js), a config.js.example is provided as a basis for a config, old args interface is still available if no config.js is provided.
3. Added ability to configure various MQTT settings such as user, password, LWT and more using the config.js file.
4. WMP - Added LIMITS and PING functions, added various input and sanity checks to the WMP client.
5. Graceful reconnection in case the WMP or MQTT clients disconnects.
6. Added "off mode" - adds an abstract "off" option to the Intesis MODE feature. this feature allows the ability to set a mode and turn on the AC at the same time or selecting mode off to turn off the AC, this is useful for Home Assistant MQTT HVAC integration which requires you use a separate MQTT switch for the ONOFF feature to turn your AC on and off, by using the "off mode" you can have the AC turn on when any mode but off is chosen and turned off by using the off mode.
when "off mode" is active the actual AC mode is published to `stat/hvac/intesis/[Intesis MAC Address]/[AC Number]/settings/standbymode` and can be changed using `cmnd/hvac/intesis/[Intesis MAC Address]/[AC Number]/settings/standbymode` topic.
7. WMP client now checks the Intesis device is ready for use (condition: all AC units report AMBTEMP and SETPTEMP above 0), until it is ready the device status topic `stat/hvac/intesis/[Intesis MAC Address]/status` will be `offline`, once ready the payload will switch to `online`.
8. Moved Constants into dedicated files, added more logging, refactored some code etc.

# Installation

Running locally:

Clone and install the necessary packages
```
git clone git@github.com:/pazoozoo123/wmp2mqtt
cd wmp2mqtt
npm install
```

Running as a Docker container:

Clone and build the image
```
git clone git@github.com:/pazoozoo123/wmp2mqtt
cd wmp2mqtt
sudo chmod u+x build_docker.sh
./build_docker.sh
```

# Usage
When running as a container:

NOTE:
If you want to have written logs stored you need to map a volume into the container with the proper permissions, create a new directory and add GID 1024 as owner and change permission to allow the container to write to the folder
```
mkdir log
chown :1024 log/
chmod g+ws log/
``` 

Using container with config.js:
Edit the config.js.example to your liking and save a copy as config.js in a known directory such as /home/wmp2mqtt/config which we will map into the container. 
Now assuming your config is located at /home/wmp2mqtt/config and you want the logs saved at /home/wmp2mqtt/log run the following command to create the container.
```
docker run -d \
	--name=wmp2mqtt \
	--network=bridge \
	-v /home/wmp2mqtt/config:/app/config \
	-v /home/wmp2mqtt/log:/app/log \
	--restart always \
  wmp2mqtt:v1.0
```

Using container with args:
Now assuming your logs are to be saved at /home/wmp2mqtt/log run the following command to create the container but replace the args with your preferred values.
```
docker run -d \
	--name=wmp2mqtt \
	--network=bridge \
    -e MQTT_SERVER='mqtt://127.0.0.1:1883'
    -e WMP_IPS=''
    -e DISCOVER='false'
    -e RETAIN='false'
	-v /home/wmp2mqtt/log:/app/log \
	--restart always \
  wmp2mqtt:v1.0
```

When running locally:
Using config.js:
Edit the config.js.example to your liking and save a copy as config.js in wmp2mqtt/config the run the following:
`node app.js`

Using args:
`node app.js [--discover] --mqtt [mqtt url] [--wmp ip address(,ip address,...)] [--retain [true/false]]`

Discovery will use IPv4 broadcast to try to detect and connect to all WMP devices on the subnet.

Updates will be provided in the MQTT topic: `stat/hvac/intesis/[Intesis MAC Address]/[AC unit number]/settings/[feature]` with the payload as the value.
For example: `stat/hvac/intesis/AABBCCDDEEFF/1/settings/ONOFF` with payload as `OFF`

Commands can be sent via the topic: `/cmnd/hvac/intesis/[Intesis MAC Address]/[AC unit number]/settings/[feature]` with the payload as the value to set to.
For example: `cmnd/hvac/intesis/AABBCCDDEEFF/1/settings/MODE` with payload as `HEAT`

Note old MQTT topic (from previous version) without [AC unit number] is still available to control a single AC with Intesis box or the AC at index 1 of an Intesis gateway.

Note that sending a command with no payload will request the current state is sent as an update.

# Example config using Home Assistant MQTT HVAC
Use config.js and activate "offMode", add the following to your configuration.yaml file, provide the proper box/gateway MAC address instead of AABBCCDDEEFF.
To add more units with a gateway simply add another duplicate of the code below from the "- name" key onwards and adjust the number after the MAC address to the index of the next AC unit.
```
mqtt:
  climate:
    - name: "AC 1"
    unique_id: "ac_1"
    availability:
        - topic: "stat/hvac/intesis/status"
        - topic: "stat/hvac/intesis/AABBCCDDEEFF/status"
    availability_mode: "all"
    max_temp: 30
    min_temp: 18
    precision: 1.0
    temperature_unit: "C"
    temp_step: 1
    action_topic: "stat/hvac/intesis/AABBCCDDEEFF/1/settings/mode"
    current_temperature_topic: "stat/hvac/intesis/AABBCCDDEEFF/1/settings/ambtemp"
    fan_mode_state_topic: "stat/hvac/intesis/AABBCCDDEEFF/1/settings/fansp"
    fan_mode_state_template: "{{ value if value == 'auto' else 'low' if value == '1' else 'medium' if value == '2' else 'high' if value == '3'}}"
    fan_mode_command_topic: "cmnd/hvac/intesis/AABBCCDDEEFF/1/settings/fansp"
    fan_mode_command_template: "{{ value if value == 'auto' else '1' if value == 'low' else '2' if value == 'medium' else '3' if value == 'high' }}"
    mode_state_topic: "stat/hvac/intesis/AABBCCDDEEFF/1/settings/mode"
    mode_state_template: "{{ 'fan_only' if value == 'fan' else value }}"
    mode_command_topic: "cmnd/hvac/intesis/AABBCCDDEEFF/1/settings/mode"
    mode_command_template: "{{ 'fan' if value == 'fan_only' else value }}"
    swing_mode_state_topic: "stat/hvac/intesis/AABBCCDDEEFF/1/settings/vaneud"
    swing_mode_state_template: "{{ 'off' if value == 'auto' else 'on' }}"
    swing_mode_command_topic: "cmnd/hvac/intesis/AABBCCDDEEFF/1/settings/vaneud"
    swing_mode_command_template: "{{ 'auto' if value == 'off' else 'swing' }}"
    temperature_state_topic: "stat/hvac/intesis/AABBCCDDEEFF/1/settings/setptemp"
    temperature_command_topic: "cmnd/hvac/intesis/AABBCCDDEEFF/1/settings/setptemp"
```

### Retain Flag
1. `false` default value. 
1. `true` When a client subscribes to that topic, if there is a retained message in the buffer, then it is immediately sent to the subscribing client, with its RETAIN flag set, so the client knows it is not a “live” value (i.e. just published), but that it is potentially “stale” or out of date. Nonetheless, it is the last-published value, and thus represents the most up-to-date value of the data on that topic.

# Notes

- Discovery will not support gateways properly as there is no way of figuring out the various AC units connected to the gateway only the AC at index 1 will be available.
- Testing was done with an Intesis gateway, some features might have broken in the upgrade process with Intesis box units, any feedback is welcomed.