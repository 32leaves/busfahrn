#!/bin/bash

git submodule init && \
git submodule update && \
npm install && \
rm bootstrap.sh
