const mod = await import('../lib/index.js')
let provider
mod.apply({ skills: { registerProvider: (factory) => { provider = factory() } } })

const list = await provider.list()
if (list.length !== 1) throw new Error('expected exactly one skill, got ' + list.length)
const entry = list[0]
const loaded = await provider.get(entry, { signal: undefined })
if (!loaded.content || loaded.content.length < 500) throw new Error('skill body is too short')
if (loaded.description.length < 20) throw new Error('skill description is too short')
console.log('SMOKE_OK', entry.name, 'description=' + entry.description.length, 'body=' + loaded.content.length)
