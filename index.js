#!/usr/bin/env node

process.env.DEBUG = '*'

const defer = require('golike-defer').default
const { createClient, Xapi } = require('xen-api')
const {
  isArray,
  map,
  mapValues,
  startsWith,
} = require('lodash')

const NULL_REF = 'OpaqueRef:NULL'

const asyncMap = (collection, iteratee) => {
  if (typeof collection.then === 'function') {
    return collection.then(collection => asyncMap(collection, iteratee))
  }

  let errorContainer
  const onError = error => {
    if (errorContainer === undefined) {
      errorContainer = { error }
    }
  }

  return Promise.all(map(collection, (item, key, collection) =>
    new Promise(resolve => {
      resolve(iteratee(item, key, collection))
    }).catch(onError)
  )).then(values => {
    if (errorContainer !== undefined) {
      throw errorContainer.error
    }
    return values
  })
}

const prepareParam = param => {
  if (typeof param === 'number') {
    return String(param)
  }

  if (typeof param !== 'object' || param === null) {
    return param
  }

  return (isArray(param) ? map : mapValues)(param, prepareParam)
}

const required = name => {
  throw new Error(`missing param <${name}>`)
}

Xapi.prototype.getRecord = function (type, ref) {
  return this.call(`${type}.get_record`, ref)
}

Xapi.prototype.createVmSnapshot = defer(async function ($defer, vmRef) {
  const vm = await this.getRecord('VM', vmRef)

  ;[ vm.VBDs, vm.VIFs, vm.VGPUs ] = await Promise.all([
    asyncMap(vm.VBDs, async vbdRef => {
      const vbd = await this.getRecord('VBD', vbdRef)
      const vdiRef = vbd.VDI
      if (vbd.type === 'Disk' && vdiRef !== NULL_REF) {
        const vdi = await this.getRecord('VDI', vdiRef)
        if (!startsWith(vdi.name_label, '[NOBAK]')) {
          const vdiSnapshotRef = await this.call('VDI.snapshot', vdiRef)
          $defer.call(this, 'call', 'VDI.destroy', vdiSnapshotRef)
          vbd.VDI = vdiSnapshotRef
        }
      }
      return vbd
    }),
    asyncMap(vm.VIFs, vifRef =>
      this.getRecord('VIF', vifRef)
    ),
    asyncMap(vm.VGPUs, vgpuRef =>
      this.getRecord('VGPUs', vgpuRef)
    ),
  ])

  return JSON.stringify(vm, null, 2)
})

Xapi.prototype.importVmSnapshot = defer(async function ($defer, vmSnapshot, srRef) {
  // const sr = await this.getRecord('SR', srRef)

  const vmRef = await this.call('VM.create', prepareParam(vmSnapshot.vm))
  $defer(this, 'call', 'VM.destroy', vmRef)
  return vmRef
})

defer.onFailure(defer(async ($defer, $onFailure, [
  url = required('url'),
  vmUuid = required('vm'),
]) => {
  const xapi = createClient({
    allowUnauthorized: true,
    url,
    watchEvents: false,
  })

  await xapi.connect()
  $defer.call(xapi, 'disconnect')

  console.log(await xapi.createVmSnapshot(
    await xapi.call('VM.get_by_uuid', vmUuid)
  ))

  // await new Promise(resolve => setTimeout(resolve, 30e3))
}))(process.argv.slice(2)).catch(
  console.error.bind(console, 'error')
)
