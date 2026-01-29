#!/bin/bash
MYSQL_HOSTS="mysql57 mysql80 mysql84"

for hostname in ${MYSQL_HOSTS}; do
  echo $hostname + node 18
  docker run -it --network=zongji_default -e MYSQL_HOST=$hostname -w /build -v $PWD:/build node:18 npm test
  echo $hostname + node 20
  docker run -it --network=zongji_default -e MYSQL_HOST=$hostname -w /build -v $PWD:/build node:20 npm test
  echo $hostname + node 22
  docker run -it --network=zongji_default -e MYSQL_HOST=$hostname -w /build -v $PWD:/build node:22 npm test
done
