import { join, resolve } from 'path'
const { camelCase } = require('lodash')
const webpack = require('webpack')
const { TsConfigPathsPlugin, CheckerPlugin } = require('awesome-typescript-loader')
const TypedocWebpackPlugin = require('typedoc-webpack-plugin')

const libraryName = require('./package.json').name

const plugins = [
  new CheckerPlugin(),
  new TsConfigPathsPlugin()
]

plugins.push(new TypedocWebpackPlugin(
  {
    theme: 'minimal',
    out: 'docs',
    target: 'es6',
    ignoreCompilerErrors: true
  },
  'src'
))
const entry = join(__dirname, `src/${libraryName}.ts`)

export default {
  entry: {
    index: entry
  },
  target: 'node',
  // Currently cheap-module-source-map is broken https://github.com/webpack/webpack/issues/4176
  devtool: 'source-map',
  output: {
    path: join(__dirname, 'dist'),
    libraryTarget: 'umd',
    library: camelCase(libraryName),
    filename: `${libraryName}.js`
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: [
          {
            loader: 'awesome-typescript-loader'
          }
        ]
      }
    ]
  },
  plugins: plugins
}
