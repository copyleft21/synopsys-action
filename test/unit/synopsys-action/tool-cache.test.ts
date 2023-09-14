import * as fs from 'fs'
import * as path from 'path'
import * as io from '@actions/io'
import * as exec from '@actions/exec'
import * as stream from 'stream'
import nock from 'nock'

const cachePath = path.join(__dirname, 'CACHE')
const tempPath = path.join(__dirname, 'TEMP')
// Set temp and tool directories before importing (used to set global state)
process.env['RUNNER_TEMP'] = tempPath
process.env['RUNNER_TOOL_CACHE'] = cachePath

// eslint-disable-next-line import/first
import * as tc from '../../../src/synopsys-action/tool-cache-local'
import * as constants from '../../../src/application-constants'
import os from 'os'

describe('@actions/tool-cache', function () {
  beforeAll(function () {
    nock('http://example.com').persist().get('/bytes/35').reply(200, {
      username: 'abc',
      password: 'def'
    })
  })

  beforeEach(async function () {
    await io.rmRF(cachePath)
    await io.rmRF(tempPath)
    await io.mkdirP(cachePath)
    await io.mkdirP(tempPath)
    Object.defineProperty(constants, 'RETRY_COUNT', {value: 3})
    Object.defineProperty(constants, 'RETRY_DELAY_IN_MILLISECONDS', {value: 10})
    Object.defineProperty(constants, 'NON_RETRY_HTTP_CODES', {value: new Set([200, 201, 401, 403, 416]), configurable: true})
  })

  afterEach(function () {
    setResponseMessageFactory(undefined)
  })

  afterAll(async function () {
    await io.rmRF(tempPath)
    await io.rmRF(cachePath)
    setGlobal('TEST_DOWNLOAD_TOOL_RETRY_MIN_SECONDS', undefined)
    setGlobal('TEST_DOWNLOAD_TOOL_RETRY_MAX_SECONDS', undefined)
  })

  it('downloads a 35 byte file', async () => {
    const downPath: string = await tc.downloadTool('http://example.com/bytes/35')

    expect(fs.existsSync(downPath)).toBeTruthy()
    expect(fs.statSync(downPath).size).toBe(35)
  })

  it('downloads a 35 byte file (dest)', async () => {
    const dest = 'test-download-file'
    try {
      const downPath: string = await tc.downloadTool('http://example.com/bytes/35', dest)

      expect(downPath).toEqual(dest)
      expect(fs.existsSync(downPath)).toBeTruthy()
      expect(fs.statSync(downPath).size).toBe(35)
    } finally {
      try {
        await fs.promises.unlink(dest)
      } catch {
        // intentionally empty
      }
    }
  })

  it('downloads a 35 byte file (dest requires mkdirp)', async () => {
    const dest = 'test-download-dir/test-download-file'
    try {
      const downPath: string = await tc.downloadTool('http://example.com/bytes/35', dest)

      expect(downPath).toEqual(dest)
      expect(fs.existsSync(downPath)).toBeTruthy()
      expect(fs.statSync(downPath).size).toBe(35)
    } finally {
      try {
        await fs.promises.unlink(dest)
        await fs.promises.rmdir(path.dirname(dest))
      } catch {
        // intentionally empty
      }
    }
  })

  it('downloads a 35 byte file after a redirect', async () => {
    nock('http://example.com').persist().get('/redirect-to').reply(303, undefined, {
      location: 'http://example.com/bytes/35'
    })

    const downPath: string = await tc.downloadTool('http://example.com/redirect-to')

    expect(fs.existsSync(downPath)).toBeTruthy()
    expect(fs.statSync(downPath).size).toBe(35)
  })

  // it('handles error from response message stream', async () => {
  //   nock('http://example.com').persist().get('/error-from-response-message-stream').reply(200, {})
  //
  //   setResponseMessageFactory(() => {
  //     const readStream = new stream.Readable()
  //     readStream._read = () => {
  //       readStream.destroy(new Error('uh oh'))
  //     }
  //     return readStream
  //   })
  //
  //   let error = new Error('unexpected')
  //   try {
  //     await tc.downloadTool('http://example.com/error-from-response-message-stream')
  //   } catch (err: any) {
  //     error = err
  //   }
  //
  //   expect(error).not.toBeUndefined()
  //   expect(error.message).toBe('uh oh')
  // })

  /*it('retries error from response message stream', async () => {
    nock('http://example.com').persist().get('/retries-error-from-response-message-stream').reply(200, {})

    let attempt = 1
    setResponseMessageFactory(() => {
      const readStream = new stream.Readable()
      let failsafe = 0
      readStream._read = () => {
        // First attempt fails
        if (attempt++ === 1) {
          readStream.destroy(new Error('uh oh'))
          return
        }

        // Write some data
        if (failsafe++ === 0) {
          readStream.push(''.padEnd(35))
          readStream.push(null) // no more data
        }
      }

      return readStream
    })

    const downPath = await tc.downloadTool('http://example.com/retries-error-from-response-message-stream')

    expect(fs.existsSync(downPath)).toBeTruthy()
    expect(fs.statSync(downPath).size).toBe(35)
  })*/

  it('has status code in exception dictionary for HTTP error code responses', async () => {
    nock('http://example.com').persist().get('/bytes/bad').reply(400, {
      username: 'bad',
      password: 'file'
    })

    expect.assertions(2)

    try {
      const errorCodeUrl = 'http://example.com/bytes/bad'
      await tc.downloadTool(errorCodeUrl)
    } catch (err: any) {
      expect(err.toString()).toContain('Unexpected HTTP response: 400')
      expect(err['httpStatusCode']).toBe(400)
    }
  })

  it('works with redirect code 302', async function () {
    nock('http://example.com').persist().get('/redirect-to').reply(302, undefined, {
      location: 'http://example.com/bytes/35'
    })

    const downPath: string = await tc.downloadTool('http://example.com/redirect-to')

    expect(fs.existsSync(downPath)).toBeTruthy()
    expect(fs.statSync(downPath).size).toBe(35)
  })

  it('works with a 502 temporary failure', async function () {
    nock('http://example.com').get('/temp502').twice().reply(502, undefined)
    nock('http://example.com').get('/temp502').reply(200, undefined)

    const statusCodeUrl = 'http://example.com/temp502'
    await tc.downloadTool(statusCodeUrl)
  })

  it("doesn't retry 502s more than 3 times", async function () {
    nock('http://example.com').get('/perm502').times(3).reply(502, undefined)

    expect.assertions(1)

    try {
      const statusCodeUrl = 'http://example.com/perm502'
      await tc.downloadTool(statusCodeUrl)
    } catch (err: any) {
      expect(err.toString()).toContain('502')
    }
  })

  it('retries 429s', async function () {
    nock('http://example.com').get('/too-many-requests-429').times(3).reply(429, undefined)
    nock('http://example.com').get('/too-many-requests-429').reply(500, undefined)

    try {
      const statusCodeUrl = 'http://example.com/too-many-requests-429'
      await tc.downloadTool(statusCodeUrl)
    } catch (err: any) {
      expect(err.toString()).toContain('500')
    }
  })

  it("doesn't retry 404", async function () {
    nock('http://example.com').get('/not-found-404').reply(404, undefined)
    nock('http://example.com').get('/not-found-404').reply(500, undefined)

    try {
      const statusCodeUrl = 'http://example.com/not-found-404'
      await tc.downloadTool(statusCodeUrl)
    } catch (err: any) {
      expect(err.toString()).toContain('404')
    }
  })

  it('supports authorization headers', async function () {
    nock('http://example.com', {
      reqheaders: {
        authorization: 'token abc123'
      }
    })
      .get('/some-file-that-needs-authorization')
      .reply(200, undefined)

    await tc.downloadTool('http://example.com/some-file-that-needs-authorization', undefined, 'token abc123')
  })

  it('supports custom headers', async function () {
    nock('http://example.com', {
      reqheaders: {
        accept: 'application/octet-stream'
      }
    })
      .get('/some-file-that-needs-headers')
      .reply(200, undefined)

    await tc.downloadTool('http://example.com/some-file-that-needs-headers', undefined, undefined, {
      accept: 'application/octet-stream'
    })
  })

  it('supports authorization and custom headers', async function () {
    nock('http://example.com', {
      reqheaders: {
        accept: 'application/octet-stream',
        authorization: 'token abc123'
      }
    })
      .get('/some-file-that-needs-authorization-and-headers')
      .reply(200, undefined)

    await tc.downloadTool('http://example.com/some-file-that-needs-authorization-and-headers', undefined, 'token abc123', {
      accept: 'application/octet-stream'
    })
  })
})

/**
 * Sets up a mock response body for downloadTool. This function works around a limitation with
 * nock when the response stream emits an error.
 */
function setResponseMessageFactory(factory: (() => stream.Readable) | undefined): void {
  setGlobal('TEST_DOWNLOAD_TOOL_RESPONSE_MESSAGE_FACTORY', factory)
}

/**
 * Sets a global variable
 */
function setGlobal<T>(key: string, value: T | undefined): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const g = global as any
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (value === undefined) {
    delete g[key]
  } else {
    g[key] = value
  }
}

function removePWSHFromPath(pathEnv: string | undefined): string {
  return (pathEnv || '')
    .split(';')
    .filter(segment => {
      return !segment.startsWith(`C:\\Program Files\\PowerShell`)
    })
    .join(';')
}