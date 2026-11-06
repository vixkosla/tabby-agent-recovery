'use strict'

const { NgModule } = require('@angular/core')
const core = require('tabby-core')
const local = require('tabby-local')
const { ipcRenderer } = require('electron')
const { install } = require('./bridge')

// Module loading happens before Angular constructs AppService and restores tabs.
install({ core, local, ipc: ipcRenderer, storage: window.localStorage })

class AgentRecoveryModule {}
NgModule({})(AgentRecoveryModule)
exports.default = AgentRecoveryModule
