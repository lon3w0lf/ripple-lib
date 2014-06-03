var crypt   = require('./crypt').Crypt;
var SignedRequest = require('./signedrequest').SignedRequest;
var request = require('superagent');
var extend  = require("extend");

var BlobClient = {};

//Blob object class
function BlobObj(url, id, key) {
  this.url      = url;
  this.id       = id;
  this.key      = key; 
  this.identity = new Identity(this);
  this.data     = { };
};

// Blob operations
// Do NOT change the mapping of existing ops
BlobObj.ops = {
  // Special
  noop: 0,

  // Simple ops
  set: 16,
  unset: 17,
  extend: 18,

  // Meta ops
  push: 32,
  pop: 33,
  shift: 34,
  unshift: 35,
  filter: 36
};


BlobObj.opsReverseMap = [ ];
for (var name in BlobObj.ops) {
  BlobObj.opsReverseMap[BlobObj.ops[name]] = name;
}

//Identity fields
var identityRoot   = 'identityVault';
var identityFields = [
  'name',
  'entityType',
  'email',
  'phone',
  'address',
  'nationalID',
  'birthday',
  'birthplace'
];

var entityTypes = [
  'individual',
  'organization',
  'corporation'
]

var addressFields = [
  'contact',
  'line1',
  'line2',
  'city',
  'region',  //state/province/region
  'postalCode',
  'country'
];

var nationalIDFields = [
  'number',
  'type',
  'country',
];

var idTypeFields = [
  'ssn',
  'taxID',
  'passport',
  'driversLicense',
  'other'
];

/**
 * Initialize a new blob object
 *
 * @param {function} fn - Callback function
 */

BlobObj.prototype.init = function(fn) {
  var self = this, url;

  if (self.url.indexOf('://') === -1) {
    self.url = 'http://' + url;
  }

  url = self.url + '/v1/blob/' + self.id;

  request.get(url, function(err, resp) {
    if (err || !resp.body || resp.body.result !== 'success') {
      return fn(new Error('Could not retrieve blob'));
    }

    self.revision = resp.body.revision;
    self.encrypted_secret = resp.body.encrypted_secret;

    if (!self.decrypt(resp.body.blob)) {
      return fn(new Error('Error while decrypting blob'));
    }

    //Apply patches
    if (resp.body.patches && resp.body.patches.length) {
      var successful = true;
      resp.body.patches.forEach(function(patch) {
        successful = successful && self.applyEncryptedPatch(patch);
      });

      if (successful) {
        self.consolidate();
      }
    }

    //return with newly decrypted blob
    fn(null, self);
  }).timeout(8000);
};

/**
 * Consolidate -
 * Consolidate patches as a new revision
 *
 * @param {function} fn - Callback function
 */

BlobObj.prototype.consolidate = function(fn) {
  // Callback is optional
  if (typeof fn !== 'function') {
    fn = function(){};
  }

  //console.log('client: blob: consolidation at revision', this.revision);
  var encrypted = this.encrypt();

  var config = {
    method: 'POST',
    url: this.url + '/v1/blob/consolidate',
    dataType: 'json',
    data: {
      blob_id: this.id,
      data: encrypted,
      revision: this.revision
    },
  };

  var signedRequest = new SignedRequest(config);

  var signed = signedRequest.signHmac(this.data.auth_secret, this.id);

  request.post(signed.url)
    .send(signed.data)
    .end(function(err, resp) {
      // XXX Add better error information to exception
      if (err) {
        fn(new Error('Failed to consolidate blob - XHR error'));
      } else if (resp.body && resp.body.result === 'success') {
        fn(null, resp.body);
      } else {
        fn(new Error('Failed to consolidate blob'));
      }
  });
};

/**
 * ApplyEncryptedPatch -
 * save changes from a downloaded patch to the blob
 *
 * @param {string} patch - encrypted patch string
 */

BlobObj.prototype.applyEncryptedPatch = function(patch) {
  try {
    var args = JSON.parse(crypt.decrypt(this.key, patch));
    var op   = args.shift();
    var path = args.shift();

    this.applyUpdate(op, path, args);
    this.revision++;

    return true;
  } catch (err) {
    //console.log('client: blob: failed to apply patch:', err.toString());
    //console.log(err.stack);
    return false;
  }
};

/**
 * Encrypt secret with unlock key
 *
 * @param {string} secretUnlockkey
 */
BlobObj.prototype.encryptSecret = function (secretUnlockKey, secret) {
  return crypt.encrypt(secretUnlockKey, secret);
};

/**
 * Decrypt secret with unlock key
 *
 * @param {string} secretUnlockkey
 */

BlobObj.prototype.decryptSecret = function(secretUnlockKey) {
  return crypt.decrypt(secretUnlockKey, this.encrypted_secret);
};

/**
 * Decrypt blob with crypt key
 *
 * @param {string} data - encrypted blob data
 */

BlobObj.prototype.decrypt = function(data) {
  try {
    this.data = JSON.parse(crypt.decrypt(this.key, data));
    return this;
  } catch (e) {
    //console.log('client: blob: decryption failed', e.toString());
    //console.log(e.stack);
    return false;
  }
};

/**
 * Encrypt blob with crypt key
 */

BlobObj.prototype.encrypt = function() {
// Filter Angular metadata before encryption
//  if ('object' === typeof this.data &&
//      'object' === typeof this.data.contacts)
//    this.data.contacts = angular.fromJson(angular.toJson(this.data.contacts));

  return crypt.encrypt(this.key, JSON.stringify(this.data));
};

/**
 * Encrypt recovery key
 *
 * @param {string} secret
 * @param {string} blobDecryptKey
 */

BlobObj.prototype.encryptBlobCrypt = function(secret, blobDecryptKey) {
  var recoveryEncryptionKey = crypt.deriveRecoveryEncryptionKeyFromSecret(secret);
  return crypt.encrypt(recoveryEncryptionKey, blobDecryptKey);
};

/**
 * Decrypt recovery key
 *
 * @param {string} secret
 */

BlobObj.prototype.decryptBlobCrypt = function(secret) {
  var recoveryEncryptionKey = crypt.deriveRecoveryEncryptionKeyFromSecret(secret);
  return crypt.decrypt(recoveryEncryptionKey, this.encrypted_blobdecrypt_key);
};

/**** Blob updating functions ****/

/**
 * Set blob element
 */

BlobObj.prototype.set = function(pointer, value, fn) {
  this.applyUpdate('set', pointer, [value]);
  this.postUpdate('set', pointer, [value], fn);
};

/**
 * Remove blob element
 */

BlobObj.prototype.unset = function(pointer, fn) {
  this.applyUpdate('unset', pointer, []);
  this.postUpdate('unset', pointer, [], fn);
};

/**
 * Extend blob object
 */

BlobObj.prototype.extend = function(pointer, value, fn) {
  this.applyUpdate('extend', pointer, [value]);
  this.postUpdate('extend', pointer, [value], fn);
};

/**
 * Prepend blob array
 */

BlobObj.prototype.unshift = function(pointer, value, fn) {
  this.applyUpdate('unshift', pointer, [value]);
  this.postUpdate('unshift', pointer, [value], fn);
};

/**
 * Filter the row(s) from an array.
 *
 * This method will find any entries from the array stored under `pointer` and
 * apply the `subcommands` to each of them.
 *
 * The subcommands can be any commands with the pointer parameter left out.
 */

BlobObj.prototype.filter = function(pointer, field, value, subcommands, callback) {
  var args = Array.prototype.slice.apply(arguments);

  if (typeof args[args.length - 1] === 'function') {
    callback = args.pop();
  }

  args.shift();

  // Normalize subcommands to minimize the patch size
  args = args.slice(0, 2).concat(normalizeSubcommands(args.slice(2), true));

  this.applyUpdate('filter', pointer, args);
  this.postUpdate('filter', pointer, args, callback);
};

/**
 * Apply udpdate to the blob
 */

BlobObj.prototype.applyUpdate = function(op, path, params) {
  // Exchange from numeric op code to string
  if (typeof op === 'number') {
    op = BlobObj.opsReverseMap[op];
  }

  if (typeof op !== 'string') {
    throw new Error('Blob update op code must be a number or a valid op id string');
  }

  // Separate each step in the 'pointer'
  var pointer = path.split('/');
  var first = pointer.shift();

  if (first !== '') {
    throw new Error('Invalid JSON pointer: '+path);
  }

  this._traverse(this.data, pointer, path, op, params);
};

//for applyUpdate function
BlobObj.prototype._traverse = function(context, pointer, originalPointer, op, params) {
  var _this = this;
  var part = _this.unescapeToken(pointer.shift());

  if (Array.isArray(context)) {
    if (part === '-') {
      part = context.length;
    } else if (part % 1 !== 0 && part >= 0) {
      throw new Error('Invalid pointer, array element segments must be a positive integer, zero or '-'');
    }
  } else if (typeof context !== 'object') {
    return null;
  } else if (!context.hasOwnProperty(part)) {
    // Some opcodes create the path as they're going along
    if (op === 'set') {
      context[part] = {};
    } else if (op === 'unshift') {
      context[part] = [];
    } else {
      return null;
    }
  }

  if (pointer.length !== 0) {
    return this._traverse(context[part], pointer, originalPointer, op, params);
  }

  switch (op) {
    case 'set':
      context[part] = params[0];
      break;
    case 'unset':
      if (Array.isArray(context)) {
        context.splice(part, 1);
      } else {
        delete context[part];
      }
      break;
    case 'extend':
      if (typeof context[part] !== 'object') {
        throw new Error('Tried to extend a non-object');
      }
      extend(true, context[part], params[0]);
      break;
    case 'unshift':
      if (typeof context[part] === 'undefined') {
        context[part] = [ ];
      } else if (!Array.isArray(context[part])) {
        throw new Error('Operator "unshift" must be applied to an array.');
      }
      context[part].unshift(params[0]);
      break;
    case 'filter':
      if (Array.isArray(context[part])) {
        context[part].forEach(function(element, i) {
          if (typeof element === 'object' && element.hasOwnProperty(params[0]) && element[params[0]] === params[1]) {
            var subpointer = originalPointer + '/' + i;
            var subcommands = normalizeSubcommands(params.slice(2));

            subcommands.forEach(function(subcommand) {
              var op = subcommand[0];
              var pointer = subpointer + subcommand[1];
              _this.applyUpdate(op, pointer, subcommand.slice(2));
            });
          }
        });
      }
      break;
    default:
      throw new Error('Unsupported op '+op);
  }
};

BlobObj.prototype.escapeToken = function(token) {
  return token.replace(/[~\/]/g, function(key) {
    return key === '~' ? '~0' : '~1';
  });
};

BlobObj.prototype.unescapeToken = function(str) {
  return str.replace(/~./g, function(m) {
    switch (m) {
      case '~0':
        return '~';
      case '~1':
        return '/';
    }
    throw new Error('Invalid tilde escape: ' + m);
  });
};

/**
 * Sumbit update to blob vault
 */

BlobObj.prototype.postUpdate = function(op, pointer, params, fn) {
  // Callback is optional
  if (typeof fn !== 'function') {
    fn = function(){};
  }

  if (typeof op === 'string') {
    op = BlobObj.ops[op];
  }

  if (typeof op !== 'number') {
    throw new Error('Blob update op code must be a number or a valid op id string');
  }

  if (op < 0 || op > 255) {
    throw new Error('Blob update op code out of bounds');
  }

  //console.log('client: blob: submitting update', BlobObj.opsReverseMap[op], pointer, params);

  params.unshift(pointer);
  params.unshift(op);

  var config = {
    method: 'POST',
    url: this.url + '/v1/blob/patch',
    dataType: 'json',
    data: {
      blob_id: this.id,
      patch: crypt.encrypt(this.key, JSON.stringify(params))
    }
  };


  var signedRequest = new SignedRequest(config);

  var signed = signedRequest.signHmac(this.data.auth_secret, this.id);

  request.post(signed.url)
  .send(signed.data)
  .end(function(err, resp) {
    if (err) {
      fn(new Error('Patch could not be saved - XHR error'));
    } else if (!resp.body || resp.body.result !== 'success') {
      fn(new Error('Patch could not be saved - bad result')); 
    } else {
      fn(null, resp.body);
    }
  });
};

/***** helper functions *****/

function normalizeSubcommands(subcommands, compress) {
  // Normalize parameter structure
  if (/(number|string)/.test(typeof subcommands[0])) {
    // Case 1: Single subcommand inline
    subcommands = [subcommands];
  } else if (subcommands.length === 1 && Array.isArray(subcommands[0]) && /(number|string)/.test(typeof subcommands[0][0])) {
    // Case 2: Single subcommand as array
    // (nothing to do)
  } else if (Array.isArray(subcommands[0])) {
    // Case 3: Multiple subcommands as array of arrays
    subcommands = subcommands[0];
  }

  // Normalize op name and convert strings to numeric codes
  subcommands = subcommands.map(function(subcommand) {
    if (typeof subcommand[0] === 'string') {
      subcommand[0] = BlobObj.ops[subcommand[0]];
    }

    if (typeof subcommand[0] !== 'number') {
      throw new Error('Invalid op in subcommand');
    }

    if (typeof subcommand[1] !== 'string') {
      throw new Error('Invalid path in subcommand');
    }

    return subcommand;
  });

  if (compress) {
    // Convert to the minimal possible format
    if (subcommands.length === 1) {
      return subcommands[0];
    } else {
      return [subcommands];
    }
  } else {
    return subcommands;
  }
}


/***** identity ****/

/** 
 * Identity class
 * 
 */

var Identity = function (blob) {
  var self  = this;
  self.blob = blob;
  
  //make sure the identity setup is valid
  self.validate = function(fn) {
    if (!self.blob) return fn(new Error("Identity must be associated with a blob"));
    else if (!self.blob.data) return fn(new Error("Invalid Blob"));  
    else if (!self.blob.data[identityRoot]) {
      self.blob.set(identityRoot, {}, function(err, res){
        if (err) return fn(err);
        else     return fn(null, true);
      }); 
    } else return fn(null, true);
  };
}; 

/**
 * getFullAddress
 * returns the address formed into a text string
 * @param {string} key - Encryption key
 */

Identity.prototype.getFullAddress = function (key) {
  if (!this.blob || 
      !this.blob.data || 
      !this.blob.data[identityRoot] ||
      !this.blob.data[identityRoot].address) {
    return "";
  }     
  
  var address = this.get('address', key);
  var text    = "";
  
  if (address.value.contact)    text += address.value.contact;
  if (address.value.line1)      text += " " + address.value.line1;
  if (address.value.line2)      text += " " + address.value.line2;
  if (address.value.city)       text += " " + address.value.city;
  if (address.value.region)     text += " " + address.value.region;
  if (address.value.postalCode) text += " " + address.value.postalCode;
  if (address.value.country)    text += " " + address.value.country;
  return text;
};

/**
 * getAll
 * get and decrypt all identity fields
 * @param {string} key  - Encryption key
 * @param {function} fn - Callback function
 */

Identity.prototype.getAll = function (key) {

  if (!this.blob || !this.blob.data || !this.blob.data[identityRoot]) {
    return {};
  }   
  
  var result = {}, identity = this.blob.data[identityRoot];
  for (var i in identity) {
    result[i] = this.get(i, key);
  }
  
  return result;
};

/**
 * get
 * get and decrypt a single identity field
 * @param {string} pointer - Field to retrieve
 * @param {string} key     - Encryption key
 */

Identity.prototype.get = function (pointer, key) {
  if (!this.blob || !this.blob.data || !this.blob.data[identityRoot]) {
    return null;
  }
  
  var data = this.blob.data[identityRoot][pointer];
  if (data && data.encrypted) {
    return decrypt(key, data);
    
  } else if (data) {
    return data;
    
  } else {
    return null;
  }
  
  function decrypt (key, data) {
    var value;
    var result = {encrypted : true};
    
    try {
      value = crypt.decrypt(key, data.value);
    } catch (e) {
      result.value  = data.value;
      result.error  = e; 
      return result;
    }
    
    try {
      result.value = JSON.parse(value);
    } catch (e) {
      result.value = value;
    }
    
    return result;
  }
};

/**
 * set
 * set and encrypt a single identity field.
 * @param {string} pointer - Field to set
 * @param {string} key     - Encryption key
 * @param {string} value   - Unencrypted data
 * @param {function} fn    - Callback function
 */

Identity.prototype.set = function (pointer, key, value, fn) {
  var self = this;
  
  if (!fn) fn = function(){ };
  
  //check fields for validity
  if (identityFields.indexOf(pointer) === -1) {
    return fn(new Error("invalid identity field"));   
  
  //validate address fields  
  } else if (pointer === 'address') {
    if (typeof value !== 'object') {
      return fn(new Error("address must be an object"));   
    }
    
    for (var addressField in value) {
      if (addressFields.indexOf(addressField) === -1) {
        return fn(new Error("invalid address field"));   
      }
    }
  
  //validate nationalID fields  
  } else if (pointer === 'nationalID') {
    if (typeof value !== 'object') {
      return fn(new Error("nationalID must be an object"));   
    }
    
    for (var idField in value) {
      if (nationalIDFields.indexOf(idField) === -1) {
        return fn(new Error("invalid nationalID field"));   
      }
      
      if (idField === 'type') {
        if (idTypeFields.indexOf(value[idField]) === -1) {
          return fn(new Error("invalid nationalID type"));   
        }      
      }
    }   
    
  //validate entity type   
  } else if (pointer === 'entityType') {
    if (entityTypes.indexOf(value) === -1) {
      return fn(new Error("invalid entity type"));   
    }     
  }
  
  this.validate(function(err, res){
    if (err) return fn(err);
    
    //NOTE: currently we will overwrite if it already exists
    //the other option would be to require decrypting with the
    //existing key as a form of authorization
    //var current = self.get(pointer, key);  
    //if (current && current.error) {
    //  return fn ? fn(current.error) : undefined;
    //}
    
    var data = {};
    data[pointer] = {
      encrypted : key ? true : false,
      value     : key ? encrypt(key, value) : value  
    };
    
    self.blob.extend("/" + identityRoot, data, fn);
  });
  
  function encrypt (key, value) {
    if (typeof value === 'object') value = JSON.stringify(value);
    return crypt.encrypt(key, value);
  }
};

/**
 * unset
 * remove a single identity field - will only be removed
 * with a valid decryption key
 * @param {string} pointer - Field to remove
 * @param {string} key     - Encryption key
 * @param {function} fn    - Callback function
 */

Identity.prototype.unset = function (pointer, key, fn) {
  
  if (!fn) fn = function(){ };
  
  //NOTE: this is rather useless since you can overwrite
  //without an encryption key
  var data = this.get(pointer, key);
  if (data && data.error) {
    return fn(data.error);
  }
  
  this.blob.unset("/" + identityRoot+"/" + pointer, fn);
};

/***** blob client methods ****/

/**
 * Blob object class
 */ 
 
exports.Blob = BlobObj;

/**
 * Get ripple name for a given address
 */

exports.getRippleName = function(url, address, fn) {
  if (!crypt.isValidAddress(address)) {
    return fn (new Error('Invalid ripple address'));
  }

  if (!crypt.isValidAddress(address)) return fn (new Error("Invalid ripple address"));
  request.get(url + '/v1/user/' + address, function(err, resp){
    if (err) {
      fn(new Error('Unable to access vault sever'));
    } else if (resp.body && resp.body.username) {
      fn(null, resp.body.username);
    } else if (resp.body && resp.body.exists === false) {
      fn (new Error('No ripple name for this address'));
    } else {
      fn(new Error('Unable to determine if ripple name exists'));
    }
  });
};

/**
 * Retrive a blob with url, id and key
 */

BlobClient.get = function (url, id, crypt, fn) {
  var blob = new BlobObj(url, id, crypt);
  blob.init(fn);
};

/**
 * Verify email address
 */

BlobClient.verify = function(url, username, token, fn) {
  url += '/v1/user/' + username + '/verify/' + token;
  request.get(url, function(err, resp){
    if (err) {
      fn(err);
    } else if (resp.body && resp.body.result === 'success') {
      fn(null, data);
    } else {
      fn(new Error('Failed to verify the account'));
    }
  });
};

/**
 * Create a blob object
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} options.id
 * @param {string} options.crypt
 * @param {string} options.unlock
 * @param {string} options.username
 * @param {string} options.masterkey
 * @param {object} options.oldUserBlob
 * @param {function} fn
 */

BlobClient.create = function(options, fn) {
  var blob = new BlobObj(options.url, options.id, options.crypt);

  blob.revision = 0;

  blob.data = {
    auth_secret: crypt.createSecret(8),
    account_id: crypt.getAddress(options.masterkey),
    email: options.email,
    contacts: [],
    created: (new Date()).toJSON()
  };

  blob.encrypted_secret = blob.encryptSecret(options.unlock, options.masterkey);

  // Migration
  if (options.oldUserBlob) {
    blob.data.contacts = options.oldUserBlob.data.contacts;
  }

  //post to the blob vault to create
  var config = {
    method: 'POST',
    url: options.url + '/v1/user',
    data: {
      blob_id: options.id,
      username: options.username,
      address: blob.data.account_id,
      auth_secret: blob.data.auth_secret,
      data: blob.encrypt(),
      email: options.email,
      hostlink: options.activateLink,
      encrypted_blobdecrypt_key: blob.encryptBlobCrypt(options.masterkey, options.crypt),
      encrypted_secret: blob.encrypted_secret
    }
  };

  var signedRequest = new SignedRequest(config);

  var signed = signedRequest.signAsymmetric(options.masterkey, blob.data.account_id, options.id);

  request.post(signed)
    .send(signed.data)
    .end(function(err, resp) {
      if (err) {
        fn(err);
      } else if (resp.body && resp.body.result === 'success') {
        fn(null, blob,resp.body);
      } else {
        fn(new Error('Could not create blob'));
      }
    });
};

exports.BlobClient = BlobClient;
