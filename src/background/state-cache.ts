export type StateCache<T> = {
  get(): Promise<T>;
  replace(next: T): void;
};

export function createStateCache<T>(initialize: () => Promise<T>): StateCache<T> {
  let hasValue = false;
  let value: T;
  let initializing: Promise<T> | undefined;

  return {
    async get() {
      if (hasValue) {
        return value;
      }

      if (!initializing) {
        initializing = initialize()
          .then((initialValue) => {
            value = initialValue;
            hasValue = true;
            return initialValue;
          })
          .catch((error: unknown) => {
            initializing = undefined;
            throw error;
          });
      }

      return initializing;
    },

    replace(next) {
      value = next;
      hasValue = true;
    }
  };
}
