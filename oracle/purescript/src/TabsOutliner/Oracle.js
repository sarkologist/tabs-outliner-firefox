"use strict";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalize(value) {
  if (value && value.constructor && value.constructor.name === "Just") {
    return normalize(value.value0);
  }
  if (value && value.constructor && value.constructor.name === "Nothing") {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

exports.parseJsonImpl = function (onError) {
  return function (onOk) {
    return function (input) {
      try {
        return onOk(JSON.parse(input));
      } catch (error) {
        return onError(error instanceof Error ? error.message : String(error));
      }
    };
  };
};

exports.fieldStringImpl = function (nothing) {
  return function (just) {
    return function (key) {
      return function (value) {
        return isObject(value) && typeof value[key] === "string" ? just(value[key]) : nothing;
      };
    };
  };
};

exports.fieldIntImpl = function (nothing) {
  return function (just) {
    return function (key) {
      return function (value) {
        return isObject(value) && Number.isInteger(value[key]) ? just(value[key]) : nothing;
      };
    };
  };
};

exports.fieldBooleanImpl = function (nothing) {
  return function (just) {
    return function (key) {
      return function (value) {
        return isObject(value) && typeof value[key] === "boolean" ? just(value[key]) : nothing;
      };
    };
  };
};

exports.fieldArrayImpl = function (nothing) {
  return function (just) {
    return function (key) {
      return function (value) {
        return isObject(value) && Array.isArray(value[key]) ? just(value[key]) : nothing;
      };
    };
  };
};

exports.fieldObjectImpl = function (nothing) {
  return function (just) {
    return function (key) {
      return function (value) {
        return isObject(value) && isObject(value[key]) ? just(value[key]) : nothing;
      };
    };
  };
};

exports.eqString = function (left) {
  return function (right) {
    return left === right;
  };
};

exports.eqInt = function (left) {
  return function (right) {
    return left === right;
  };
};

exports.notBoolean = function (value) {
  return !value;
};

exports.andBoolean = function (left) {
  return function (right) {
    return left && right;
  };
};

exports.orBoolean = function (left) {
  return function (right) {
    return left || right;
  };
};

exports.addInt = function (left) {
  return function (right) {
    return left + right;
  };
};

exports.subInt = function (left) {
  return function (right) {
    return left - right;
  };
};

exports.maxInt = function (left) {
  return function (right) {
    return Math.max(left, right);
  };
};

exports.minInt = function (left) {
  return function (right) {
    return Math.min(left, right);
  };
};

exports.intToString = function (value) {
  return String(value);
};

exports.appendString = function (left) {
  return function (right) {
    return left + right;
  };
};

exports.mapArray = function (f) {
  return function (values) {
    return values.map(f);
  };
};

exports.filterArray = function (f) {
  return function (values) {
    return values.filter(f);
  };
};

exports.foldlArray = function (f) {
  return function (initial) {
    return function (values) {
      return values.reduce(function (acc, value) {
        return f(acc)(value);
      }, initial);
    };
  };
};

exports.foldlWithIndexArray = function (f) {
  return function (initial) {
    return function (values) {
      return values.reduce(function (acc, value, index) {
        return f(index)(acc)(value);
      }, initial);
    };
  };
};

exports.anyArray = function (f) {
  return function (values) {
    return values.some(f);
  };
};

exports.lengthArray = function (values) {
  return values.length;
};

exports.snocArray = function (values) {
  return function (value) {
    return values.concat([value]);
  };
};

exports.appendArray = function (left) {
  return function (right) {
    return left.concat(right);
  };
};

exports.indexArrayImpl = function (nothing) {
  return function (just) {
    return function (index) {
      return function (values) {
        return index >= 0 && index < values.length ? just(values[index]) : nothing;
      };
    };
  };
};

exports.findArrayImpl = function (nothing) {
  return function (just) {
    return function (predicate) {
      return function (values) {
        const found = values.find(predicate);
        return found === undefined ? nothing : just(found);
      };
    };
  };
};

exports.findIndexArrayImpl = function (nothing) {
  return function (just) {
    return function (predicate) {
      return function (values) {
        const index = values.findIndex(predicate);
        return index < 0 ? nothing : just(index);
      };
    };
  };
};

exports.mapWithIndexArray = function (f) {
  return function (values) {
    return values.map(function (value, index) {
      return f(index)(value);
    });
  };
};

exports.snocIfEnd = function (value) {
  return function (targetIndex) {
    return function (originalValues) {
      return function (resultValues) {
        return targetIndex >= originalValues.length ? resultValues.concat([value]) : resultValues;
      };
    };
  };
};

exports.sortWindows = function (windows) {
  return windows.slice().sort(function (left, right) {
    return left.id - right.id;
  });
};

exports.sortTabs = function (tabs) {
  return tabs.slice().sort(function (left, right) {
    return left.windowId - right.windowId || left.index - right.index || left.id - right.id;
  });
};

exports.sortNodes = function (nodes) {
  return nodes.slice().sort(function (left, right) {
    return left.id.localeCompare(right.id);
  });
};

exports.stringifyOk = function (snapshots) {
  return JSON.stringify({ version: 1, ok: true, snapshots: normalize(snapshots) });
};

exports.stringifyErr = function (error) {
  return JSON.stringify({ version: 1, ok: false, error: normalize(error) });
};
