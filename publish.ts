// custom script for https://deno.land/x/publish

export async function prepublish(version: string) {
  const p = Deno.run({
    cmd: ['deno', 'run', '-A', 'build.ts'],
    cwd: './compiler',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const { success } = await p.status()
  if (success) {
    const data = await Deno.readTextFile('./import_map.json')
    const importMap = JSON.parse(data)
    Object.assign(importMap, {
      'aleph': `https://deno.land/x/aleph@${version}/mod.ts`,
      'aleph/': `https://deno.land/x/aleph@${version}/`,
    })
    await Deno.writeTextFile(
      './import_map.json',
      JSON.stringify(importMap, undefined, 2)
    )
  }
  p.close()
  return success
}
