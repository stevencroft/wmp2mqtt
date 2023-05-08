#!/bin/sh
docker build -t "wmp2mqtt:v1.0" -f docker/arm64v8/Dockerfile .
docker build -t "wmp2mqtt:v1.0" -f docker/amd64/Dockerfile .
