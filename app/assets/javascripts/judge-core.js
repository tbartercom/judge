// Judge {version}
// (c) 2011–2012 Joe Corcoran
// http://raw.github.com/joecorcoran/judge/master/LICENSE.txt

// This is judge-core.js: the JavaScript part of Judge. Judge is a client-side
// validation gem for Rails 3. You can find the Judge gem API documentation at
// <http://joecorcoran.github.com/judge/>. Hopefully the comments here will help
// you understand what's happening under the hood.

(function() {

  var root = this;

  // The judge namespace.
  var judge = root.judge = {},
      _     = root._;

  judge.VERSION = '{version}';

  // Trying to be a bit more descriptive than the basic error types allow.
  var DependencyError = function(message) {
    this.name = 'DependencyError';
    this.message = message;
  };
  DependencyError.prototype = new Error();
  DependencyError.prototype.constructor = DependencyError;

  // Throw dependency errors if necessary.
  if (typeof _ === 'undefined') {
    throw new DependencyError('Ensure underscore.js is loaded');
  }
  if (_.isUndefined(root.JSON)) {
    throw new DependencyError(
      'Judge depends on the global JSON object (load json2.js in old browsers)'
    );
  }

  // Returns the object type as represented in `Object.prototype.toString`.
  var objectString = function(object) {
    var string = Object.prototype.toString.call(object);
    return string.replace(/\[|\]/g, '').split(' ')[1];
  };

  // A way of checking isArray, but including weird object types that are
  // returned from collection queries.
  var isCollection = function(object) {
    var type  = objectString(object),
        types = [
          'Array',
          'NodeList',
          'StaticNodeList',
          'HTMLCollection',
          'HTMLFormElement',
          'HTMLAllCollection'
        ];
    return _(types).include(type);
  };

  // eval is used here for stuff like `(3, '<', 4) => '3 < 4' => true`.
  var operate = function(input, operator, validInput) {
    return eval(input+' '+operator+' '+validInput);
  };

  // Some nifty numerical helpers.
  var
    isInt  = function(value) { return value === +value && value === (value|0); },
    isEven = function(value) { return (value % 2 === 0) ? true : false; },
    isOdd  = function(value) { return !isEven(value); };

  // Converts a Ruby regular expression, given as a string, into JavaScript.
  // This is rudimentary at best, as there are many, many differences between
  // Ruby and JavaScript when it comes to regexp-fu. The plan is to replace this
  // with an XRegExp plugin which will port some Ruby regexp features to
  // JavaScript.
  var convertFlags = function(string) {
    var on = string.split('-')[0];
    return (/m/.test(on)) ? 'm' : '';
  };
  var convertRegExp = function(string) {
    var parts  = string.slice(1, -1).split(':'),
        flags  = parts.shift().replace('?', ''),
        source = parts.join(':').replace(/\\\\/g, '\\');
    return new RegExp(source, convertFlags(flags));
  };

  // Returns a browser-specific XHR object, or null if one cannot be constructed.
  var reqObj = function() {
    return (
      (root.ActiveXObject && new root.ActiveXObject('Microsoft.XMLHTTP')) ||
      (root.XMLHttpRequest && new root.XMLHttpRequest()) ||
      null
    );
  };

  // Performs a GET request using the browser's XHR object. This provides very
  // basic ajax capability and was written specifically for use in the provided
  // uniqueness validator without requiring jQuery.
  var get = judge.get = function(url, success, error) {
    var req = reqObj();
    if (!!req) {
      req.onreadystatechange = function() {
        if (req.readyState === 4) {
          req.onreadystatechange = void 0;
          var callback = /^20\d$/.test(req.status) ? success : error;
          callback(req.status, req.responseHeaders, req.responseText);
        }
      };
      req.open('GET', url, true);
      req.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      req.send();
    }
    return req;
  };

  // Some helper methods for working with Rails-style input attributes.
  var
    attrFromName = function(name) {
      var matches, attr = '';
      if (matches = name.match(/\[(\w+)\]$/)) {
        attr = matches[1];
      }
      return attr;
    };
    classFromName = function(name) {
      var bracketed, klass = '';
      if (bracketed = name.match(/\[(\w+)\]/g)) {
        klass = (bracketed.length > 1) ? camelize(debracket(bracketed[0])) : name.match(/^\w+/)[0];
      }
      return klass;
    };
    debracket = function(str) {
      return str.replace(/\[|\]/g, '');
    };
    camelize = function(str) {
      return str.replace(/(^[a-z]|\_[a-z])/g, function($1) {
        return $1.toUpperCase().replace('_','');
      });
    };

  // Build the URL necessary to send a GET request to the mounted validations
  // controller to check the validity of the given form element.
  var urlFor = judge.urlFor = function(el, kind) {
    var path   = judge.enginePath + '/validate',
        params = {
          'class'    : classFromName(el.name),
          'attribute': attrFromName(el.name),
          'value'    : encodeURIComponent(el.value),
          'kind'     : kind
        };
    return encodeURI(path + queryString(params));
  };

  // Convert an object literal into an encoded query string.
  var queryString = function(obj) {
    var e  = encodeURIComponent,
        qs = _.reduce(obj, function(memo, value, key) {
      return memo + e(key) + '=' + e(value) + '&';
    }, '?');
    return qs.replace(/&$/, '').replace(/%20/g, '+');
  };

  // Default path to mounted engine. Override this if you decide to mount
  // Judge::Engine at a different location.
  judge.enginePath = '/judge';

  // Provides event dispatch behaviour when mixed into an object. Concept
  // borrowed from Backbone.js, although this implementation is minimal by
  // comparison.
  var Dispatcher = judge.Dispatcher = {
    on: function(event, callback) {
      if (!_.isFunction(callback)) return this;
      if (_.isUndefined(this.callbacks)) this.callbacks = {};
      var callbacks = this.callbacks[event] || (this.callbacks[event] = []);
      callbacks.push(callback);
      return this;
    },
    trigger: function(event) {
      if (!this.callbacks) return this;
      var args      = _.rest(arguments),
          callbacks = this.callbacks[event] || (this.callbacks[event] = []);
      _.each(callbacks, function(callback) {
        callback.apply(this, args);
      });
      return this;
    }
  };

  // A queue of closed or pending Validation objects.
  var ValidationQueue = judge.ValidationQueue = function(element) {
    this.element = element, this.closed = false;
    this.validations = { pending: [], closed: [] }
    this.attrValidators = JSON.parse(this.element.getAttribute('data-validate'));
    
    var
      isClosed = function() {
        if (this.pending.length === 0) this.close();
      },
      add = function(validation) {
        if (this.closed) return null;
        if (validation.closed()) {
          this.validations.closed.push(validation);
        } else {
          this.validations.pending.push(validation);
          validation.on('closed', _.bind(isClosed, this));
        }
        return this;
      };

    var allValidators = _.extend(judge.eachValidators, judge.customValidators);
    _.each(this.attrValidators, function(av) {
      if (this.element.value.length || av.options.allow_blank !== true) {
        var method     = _.bind(allValidators[av.kind], this.element),
            validation = method(av.options, av.messages);
        add.call(this, validation);
      }
    }, this);
  };
  _.extend(ValidationQueue.prototype, Dispatcher, {
    close: function() {
      this.closed = true;
      this.trigger('closed', this.status, this.getMessages());
    },
    status: function() {
      if (this.validation.pending.length > 0) return 'pending';
      return (this.getMessages().length === 0) ? 'valid' : 'invalid';
    },
    getMessages: function() {
      return _.invoke(this.closed, 'getMessages');
    }
  });

  // Event-capable object returned by validator methods.
  var Validation = judge.Validation = function(messages) {
    if (_.isArray(messages)) this.close(messages);
    return this;
  };
  _.extend(Validation.prototype, Dispatcher, {
    getMessages: function() {
      return this.messages || null;
    },
    close: function(messages) {
      if (_.isUndefined(messages) || this.closed()) return null;
      if (_.isString(messages)) messages = JSON.parse(messages);
      if (!_.has(this, 'messages')) this.messages = [];
      this.messages = messages;
      this.trigger('closed', this.messages.length === 0, this.messages);
      return this;
    },
    closed: function() {
      return _.isArray(this.messages);
    },
    status: function() {
      if (!this.closed()) return 'pending';
      return this.messages.length > 0 ? 'invalid' : 'valid';
    }
  });

  // Ported ActiveModel validators.
  // See <http://api.rubyonrails.org/classes/ActiveModel/Validations.html> for
  // the originals.
  judge.eachValidators = {
    // ActiveModel::Validations::PresenceValidator
    presence: function(options, messages) {
      return new Validation(this.value.length ? [] : [messages.blank]);
    },
    
    // ActiveModel::Validations::LengthValidator
    length: function(options, messages) {
      var msgs = [],
          types = {
            minimum: { operator: '<',  message: 'too_short' },
            maximum: { operator: '>',  message: 'too_long' },
            is:      { operator: '!=', message: 'wrong_length' }
          };
      _(types).each(function(properties, type) {
        var invalid = operate(this.value.length, properties.operator, options[type]);
        if (_(options).has(type) && invalid) {
          msgs.push(messages[properties.message]);
        }
      }, this);
      return new Validation(msgs);
    },
    
    // ActiveModel::Validations::ExclusionValidator
    exclusion: function(options, messages) {
      var stringIn = _(options['in']).map(function(o) {
        return o.toString();
      });
      return new Validation(
        _.include(stringIn, this.value) ? [messages.exclusion] : []
      );
    },
    
    // ActiveModel::Validations::InclusionValidator
    inclusion: function(options, messages) {
      var stringIn = _(options['in']).map(function(o) {
        return o.toString();
      });
      return new Validation(
        !_.include(stringIn, this.value) ? [messages.inclusion] : []
      );
    },
    
    // ActiveModel::Validations::NumericalityValidator
    numericality: function(options, messages) {
      var operators = {
            greater_than: '>',
            greater_than_or_equal_to: '>=',
            equal_to: '==',
            less_than: '<',
            less_than_or_equal_to: '<='
          },
          msgs = [],
          parsedValue = parseFloat(this.value, 10); 

      if (isNaN(Number(this.value))) {
        msgs.push(messages.not_a_number);
      } else {
        if (options.odd && isEven(parsedValue)) msgs.push(messages.odd);
        if (options.even && isOdd(parsedValue)) msgs.push(messages.even);
        if (options.only_integer && !isInt(parsedValue)) msgs.push(messages.not_an_integer);
        _(operators).each(function(operator, key) {
          var valid = operate(parsedValue, operators[key], parseFloat(options[key], 10));
          if (_(options).has(key) && !valid) {
            msgs.push(messages[key]);
          }
        });
      }
      return new Validation(msgs);
    },
    
    // ActiveModel::Validations::FormatValidator
    format: function(options, messages) {
      var msgs  = [];
      if (_(options).has('with')) {
        var withReg = convertRegExp(options['with']);
        if (!withReg.test(this.value)) {
          msgs.push(messages.invalid);
        }
      }
      if (_(options).has('without')) {
        var withoutReg = convertRegExp(options.without);
        if (withoutReg.test(this.value)) {
          msgs.push(messages.invalid);
        }
      }
      return new Validation(msgs);
    },
    
    // ActiveModel::Validations::AcceptanceValidator
    acceptance: function(options, messages) {
      return new Validation(this.checked === true ? [] : [messages.accepted]);
    },
    
    // ActiveModel::Validations::ConfirmationValidator
    confirmation: function(options, messages) {
      var id       = this.getAttribute('id'),
          confId   = id + '_confirmation',
          confElem = root.document.getElementById(confId);
      return new Validation(
        this.value === confElem.value ? [] : [messages.confirmation]
      );
    },

    // ActiveModel::Validations::UniquenessValidator
    uniqueness: function(options, messages) {
      var validation = new Validation();          
      get(urlFor(this, 'uniqueness'),
        function(status, headers, text) {
          validation.close(text);
        },
        function() {
          throw new Error('Uniqueness validation request was unsuccessful');
        }
      );
      return validation;
    }
  };

  // This object should contain any custom EachValidator methods, named
  // to correspond to custom validators used in the model.
  judge.customValidators = {};

  judge.validate = function(element, callback) {
    return new ValidationQueue(element);
  };

}).call(this);