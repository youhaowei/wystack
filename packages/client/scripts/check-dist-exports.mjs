const entrypoints = ['index', 'core', 'react', 'web', 'electron']

await Promise.all(entrypoints.map((entrypoint) => import(`../dist/${entrypoint}.js`)))
