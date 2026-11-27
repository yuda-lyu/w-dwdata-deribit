import rollupFiles from 'w-package-tools/src/rollupFiles.mjs'


let fdSrc = './src'
let fdTar = './dist'


rollupFiles({
    fns: 'WDwdataDeribit.mjs',
    fdSrc,
    fdTar,
    // nameDistType: 'kebabCase',
    hookNameDist: () => {
        return 'w-dwdata-deribit'
    },
    globals: {
        'path': 'path',
        'fs': 'fs',
        'zlib': 'zlib',
    },
    external: [
        'path',
        'fs',
        'zlib',
    ],
})

