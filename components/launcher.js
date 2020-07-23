const child = require('child_process')
const path = require('path')
const Handler = require('./handler')
const fs = require('fs')
const fsPromises = fs.promises
const EventEmitter = require('events').EventEmitter

const exists = file => fsPromises.access(file, fs.constants.F_OK)
  .then(() => true)
  .catch(() => false)

class MCLCore extends EventEmitter {
  async launch (options) {
    this.options = options
    this.options.root = path.resolve(this.options.root)
    this.options.overrides = {
      detached: true,
      ...this.options.overrides,
      url: {
        meta: 'https://launchermeta.mojang.com',
        resource: 'https://resources.download.minecraft.net',
        mavenForge: 'http://files.minecraftforge.net/maven/',
        defaultRepoForge: 'https://libraries.minecraft.net/',
        fallbackMaven: 'https://search.maven.org/remotecontent?filepath=',
        ...this.options.overrides
          ? this.options.overrides.url
          : undefined
      }
    }
    // ForgeWrapper fork that is maintained on a side repo (https://github.com/Pierce01/ForgeWrapper)
    this.options.forgeWrapper = {
      jar: path.join(__dirname, 'fw.jar'),
      version: '1.4.1-mclc'
    }

    this.handler = new Handler(this)

    await fsPromises.readFile(path.join(__dirname, '..', 'package.json'), { encoding: 'utf8' })
      .then(file => this.emit('debug', `[MCLC]: MCLC version ${JSON.parse(file).version}`))
      .catch(() => this.emit('debug', '[MCLC]: Package JSON not found, skipping MCLC version check.'))
    const java = await this.handler.checkJava(this.options.javaPath || 'java')
    if (!java.run) {
      this.emit('debug', `[MCLC]: Couldn't start Minecraft due to: ${java.message}`)
      this.emit('close', 1)
      return null
    }

    await fsPromises.mkdir(this.options.root)
      .then(() => this.emit('debug', '[MCLC]: Attempting to create root folder'))
      .catch(() => false)

    if (this.options.clientPackage) {
      this.emit('debug', `[MCLC]: Extracting client package to ${this.options.root}`)
      await this.handler.extractPackage()
    }

    if (this.options.installer) {
      // So the forge installer can run without breaking :)
      const profilePath = path.join(this.options.root, 'launcher_profiles.json')
      if (!await exists(profilePath)) { fsPromises.writeFileSync(profilePath, JSON.stringify({}, null, 4)) }
      await this.handler.runInstaller(this.options.installer)
    }

    const directory = this.options.overrides.directory || path.join(this.options.root, 'versions', this.options.version.number)
    this.options.directory = directory

    const versionFile = await this.handler.getVersion()
    const mcPath = this.options.overrides.minecraftJar || (this.options.version.custom
      ? path.join(this.options.root, 'versions', this.options.version.custom, `${this.options.version.custom}.jar`)
      : path.join(directory, `${this.options.version.number}.jar`))
    const nativePath = await this.handler.getNatives()

    if (!await exists(mcPath)) {
      this.emit('debug', '[MCLC]: Attempting to download Minecraft version jar')
      await this.handler.getJar()
    }

    let forge = null
    let custom = null
    if (this.options.forge) {
      this.options.forge = path.resolve(this.options.forge)
      this.emit('debug', '[MCLC]: Detected Forge in options, getting dependencies')
      forge = await this.handler.getForgeDependenciesLegacy()
      if (forge === false) custom = await this.handler.getForgedWrapped()
    }
    if (this.options.version.custom || custom) {
      if (!custom) this.emit('debug', '[MCLC]: Detected custom in options, setting custom version file')
      custom = custom || JSON.parse(await fsPromises.readFile(path.join(this.options.root, 'versions', this.options.version.custom, `${this.options.version.custom}.json`), { encoding: 'utf8' }))
    }

    const args = []

    let jvm = [
      '-XX:-UseAdaptiveSizePolicy',
      '-XX:-OmitStackTraceInFastThrow',
      '-Dfml.ignorePatchDiscrepancies=true',
      '-Dfml.ignoreInvalidMinecraftCertificates=true',
      `-Djava.library.path=${nativePath}`,
      `-Xmx${this.options.memory.max}M`,
      `-Xms${this.options.memory.min}M`
    ]
    if (this.handler.getOS() === 'osx') {
      if (parseInt(versionFile.id.split('.')[1]) > 12) jvm.push(await this.handler.getJVM())
    } else jvm.push(await this.handler.getJVM())

    if (this.options.customArgs) jvm = jvm.concat(this.options.customArgs)

    const classes = this.options.overrides.classes || this.handler.cleanUp(await this.handler.getClasses(custom))
    const classPaths = ['-cp']
    const separator = this.handler.getOS() === 'windows' ? ';' : ':'
    this.emit('debug', `[MCLC]: Using ${separator} to separate class paths`)
    if (forge) {
      this.emit('debug', '[MCLC]: Setting Forge class paths')
      classPaths.push(`${path.resolve(this.options.forge)}${separator}${forge.paths.join(separator)}${separator}${classes.join(separator)}${separator}${mcPath}`)
      classPaths.push(forge.forge.mainClass)
    } else {
      const file = custom || versionFile
      // So mods like fabric work.
      const jar = (await exists(mcPath))
        ? `${separator}${mcPath}`
        : `${separator}${path.join(directory, `${this.options.version.number}.jar`)}`
      classPaths.push(`${classes.join(separator)}${jar}`)
      classPaths.push(file.mainClass)
    }

    this.emit('debug', '[MCLC]: Attempting to download assets')
    await this.handler.getAssets()

    // Forge -> Custom -> Vanilla
    const modification = forge ? forge.forge : null || custom ? custom : null
    const launchOptions = await this.handler.getLaunchOptions(modification)

    const launchArguments = args.concat(jvm, classPaths, launchOptions)
    this.emit('arguments', launchArguments)
    this.emit('debug', `[MCLC]: Launching with arguments ${launchArguments.join(' ')}`)

    const minecraft = child.spawn(this.options.javaPath ? this.options.javaPath : 'java', launchArguments,
      { cwd: this.options.overrides.cwd || this.options.root, detached: this.options.overrides.detached })
    minecraft.stdout.on('data', (data) => this.emit('data', data.toString('utf-8')))
    minecraft.stderr.on('data', (data) => this.emit('data', data.toString('utf-8')))
    minecraft.on('close', (code) => this.emit('close', code))

    return minecraft
  }
}

module.exports = MCLCore
