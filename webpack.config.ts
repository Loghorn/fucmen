import { join, resolve } from 'path'
const { camelCase } = require('lodash')
const webpack = require('webpack')
const { TsConfigPathsPlugin, CheckerPlugin } = require('awesome-typescript-loader')
const TypedocWebpackPlugin = require('typedoc-webpack-plugin')
const UglifyJSPlugin = require('uglifyjs-webpack-plugin')

const libraryName = require('./package.json').name

const plugins = [
  new CheckerPlugin(),
  new TsConfigPathsPlugin()
]

plugins.push(new TypedocWebpackPlugin(
  {
    theme: 'minimal',
    out: 'docs',
    target: 'es2016',
    ignoreCompilerErrors: true
  },
  'src'
))

if (process.env.NODE_ENV === 'production') {
  plugins.push(new UglifyJSPlugin({ sourceMap: true }))
}

const entry = join(__dirname, `src/${libraryName}.ts`)

export default {
  entry: {
    index: entry
  },
  target: 'node',
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
