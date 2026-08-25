---
'@powersync/mysql-zongji': patch
---

Extend the type definitions to cover functionality powersync-service relies on: the @vlasky/mysql `enableKeepAlive` and `keepAliveInitialDelay` options on `ZongjiOptions`, the `ctrlConnection` property and connection-input constructor form on `ZongJi`, and `destroy()` on `MySQLConnection`. Types only, no runtime changes.
