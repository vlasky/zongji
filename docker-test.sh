#!/bin/bash
MYSQL_HOSTS="mysql57 mysql81 mysql82"

for hostname in ${MYSQL_HOSTS}; do
  echo $hostname + node 16
  docker run -it --network=zongji_default -e MYSQL_HOST=$hostname -w /build -v $PWD:/build node:16 npm test
  echo $hostname + node 18
  docker run -it --network=zongji_default -e MYSQL_HOST=$hostname -w /build -v $PWD:/build node:18 npm test
  echo $hostname + node 20
  docker run -it --network=zongji_default -e MYSQL_HOST=$hostname -w /build -v $PWD:/build node:20 npm test
done
