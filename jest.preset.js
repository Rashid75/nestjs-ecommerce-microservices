const nxPreset = require('@nx/jest/preset').default;

module.exports = {
  ...nxPreset,

  /**
   * Loads `reflect-metadata` before any test file.
   *
   * Every decorator in this project — `@IsInt()`, `@Type()`, `@Column()`,
   * `@Injectable()` — writes to the metadata registry that this polyfill
   * installs on `Reflect`. Without it, the first decorated class to be
   * imported throws `Reflect.getMetadata is not a function`.
   *
   * The applications never hit this because `@nestjs/core` imports it during
   * bootstrap. Jest has no bootstrap, so it has to be declared here.
   *
   * It used to work by accident: `@nestjs/swagger` imported it as a side
   * effect, and removing that package is what exposed the gap. Relying on a
   * transitive side effect for something this fundamental is exactly the kind
   * of dependency that breaks during an unrelated change — so it is now
   * explicit.
   */
  setupFiles: [...(nxPreset.setupFiles ?? []), 'reflect-metadata'],
};
