declare module 'node-pack' {
  function encode(value: any, dictionary?: any[]): Buffer
  function decode(buffer: Buffer, dictionary?: any[]): any
}
