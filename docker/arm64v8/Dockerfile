FROM arm64v8/node:19-alpine

ENV MQTT_SERVER=mqtt://127.0.0.1:1883
ENV WMP_IPS=""
ENV DISCOVER="false"
ENV RETAIN="false"

WORKDIR /app

COPY ./* ./

RUN npm install

RUN chmod a+rw run_wmp2mqtt.sh

RUN addgroup --g 1024 wmp2mqttgroup
RUN adduser -u 1024 -G wmp2mqttgroup --gecos "" --disabled-password wmpmqtt

RUN mkdir /app/log
RUN chown wmpmqtt:wmp2mqttgroup /app/log

USER wmpmqtt


ENTRYPOINT ["sh", "./run_wmp2mqtt.sh"]
