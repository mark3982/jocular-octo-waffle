/*
	$
*/

var http = require('http');
var fs = require('fs');
var crypto = require('crypto');
//var Canvas = require('canvas');
var ws = require('ws');
var spawn = require('child_process').spawn;
var dbjuggle = require('./dbjuggle.js');

var httphandler = require('./httphandler.js');
var Slave = require('./slave.js');
var slaveman = require('./slaveman.js');
var common = require('./common.js');

var hurt = {
	server: {},
	util: {}
};


/*
  This will get the nearest leaf on the patch tree. It will stop when it
  either reaches the highest depth, or when it finds the first leaf that
  has is unused. It will return either the patch host ID found, patch for
  the coordinates that is unused or used, or both.
*/
hurt.util.getPatchTreeLeaf = function(state, zid, x, y, z, mxyz, cb) {
  var patches = common.buildPatchListFromXYZ(x, y, z, mxyz);
  console.log('[getPatchTreeLeaf]', {
    x: x,
    y: y,
    z: z,
    mxyz: mxyz,
    patches: patches,
  });
  hurt.util.getPatchTreeLeafWithPatches(state, zid, patches, cb);
};

hurt.util.getPatchTreeLeafWithPatches = function (state, zid, patches, cb) {
  var tmp = [];

  if (patches.length == 0 || patches == undefined || patches == null) {
    throw new Error('patches was empty, null, or undefined');
  }

  for (var x = 0; x < patches.length; ++x) {
    tmp.push(patches[x][0]);
  }

  var trans = state.db.transaction();
  trans.add(
    'SELECT patch, patch_host_id, up FROM patch_tree WHERE zid = ? AND patch IN (' + tmp.join(',') + ') ORDER BY patch',
     [zid], 
     'r'
  );

  trans.execute(function (t) {
    var rows = t.results.r.rows;
    for (var x = 0; x < rows.length; ++x) {
      if (rows[x].patch_host_id > -1 || rows[x].up[0] == 0) {
        cb(rows[x].patch_host_id, rows[x].patch);
        return;
      }
    }
    cb(-1, 0);
  });
};

/*
  This allocates the highest unused patch level for each of the specified patches. This is used
  to allocate patches in order to launch a zone. We do not wish to allocate very small individual
  patches for each entity so we allocate as large of a patch as possible.
*/
hurt.util.setPatchTreeLeafByPatches = function(state, zid, patches, mxyz, patch_host_id, cb) {
  console.log('[setPatchTreeLeafByPatches]', patches, patch_host_id);
  function doit(i) {
    console.log('[setPatchTreeLeafByPatches]', { patch: patches[i] });
    var up = common.getPatchesUpFromXYZD(patches[i], mxyz);
    up.reverse();
    console.log('[setPatchTreeLeafByPatches]', { up: up });
    var r = hurt.util.getPatchTreeLeafWithPatches(state, zid, up, function(_, highest_patch_unused) {
      for (var x = 0; x < up.length; ++x) {
        if (up[x][0] == highest_patch_unused) {
          up = up.slice(0, x + 1);
          break;
        }
      }
      hurt.util.setPatchTreeLeafWithPatches(state, zid, up, patch_host_id, function () {
        if (i + 1 < patches.length) {
          return doit(i + 1);
        }
        cb();
      }); 
    });
  }
  doit(0);
};

/*
  This will update the patch tree with a leaf.
*/
hurt.util.setPatchTreeLeaf = function(state, zid, x, y, z, mxyz, patch_host_id, cb) {
  var patches = common.BuildPotentialPatchListFromXYZ(x, y, z, mxyz);
  hurt.util.setPatchTreeLeafWithPatches(state, zid, patches, patch_host_id, cb);
};

hurt.util.setPatchTreeLeafWithPatches = function(state, zid, patches, patch_host_id, cb) {
  var ct = (new Date()).getTime() / 1000;

  if (patch_host_id != 0 && (!patch_host_id || patch_host_id < 0)) {
    throw new Error('patch_host_id is invalid');
  }

  console.log('setPatchTreeLeafWithPatches', patches, patch_host_id);

  function doit(x) {
    var cur = patches[x];
    var leaf;
    if (x == patches.length - 1) {
      leaf = patch_host_id;
    } else {
      leaf = -1;
    }
    console.log('leaf', x, patches.length, leaf, cur[0]);
    var trans = state.db.transaction();
    trans.add(
      'INSERT INTO patch_tree (zid, patch, up, last_update, patch_host_id) VALUES (?, ?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE up = up | ?, last_update = ?, patch_host_id = ?',
      [zid, cur[0], cur[1], ct, leaf, cur[1], ct, leaf],
      'r'
    );
    trans.execute(function (t) {
      if (t.results.r.err) {
        console.log('[hurt.util.setPatchTreeLeaf] failed to set leaf; aborting despite dire consequences.', x, y, z, mxyz, patch_host_id);
        return;
      }
      if (x + 1 >= patches.length) {
        cb();
        return;
      }
      doit(x + 1);
    });
  }
  doit(0);
}; 

/*
	This will ensure that the zone is hosted and then execute the callback.

	@param(state):        state structure
	@param(state).note:   Currently uses `db` filed to get a transaction.
	@param(zid):          zone identifier
	@param(zid).type:     numeric
	@param(cb):           callback
	@param(cb).type:      function reference
	@param(cb).note:      This may be executed sync or async.
*/
hurt.util.checkPatchHosted = function (state, zid, x, y, z, mxyz, cb) {
  hurt.util.getPatchTreeLeaf(state, zid, x, y, z, mxyz, function (patch_host_id, patch) {
    var trans = state.db.transaction();
    trans.add(
      'SELECT slaveid, address, lastalive, up FROM patch_host WHERE patch_host_id = ?', 
      [patch_host_id],
      'r'
    );
    trans.execute(function (t) {
      var row = t.results.r.rows[0];
      var ct = (new Date()).getTime() / 1000;
      if (row) {
        /*
          If it is _not_ up then consider it dead with same parameters.
        */
        if (!row.up[0]) {
          // TODO: ... not sure if I am using that right since it is a BIT(?) field
          cb(null, 999999, patch, null);
          return;
        }
        cb(row.address, ct - row.lastalive, patch, row.slaveid);
      } else {
        cb(null, 999999, patch, null);
      }
      return;
    });  
  });
}

hurt.util.ensureHostedByPatch = function (state, zid, x, y, z, mxyz, cb, delay, delaycb) {
  hurt.util.checkPatchHosted(state, zid, x, y, z, mxyz, function (address, delta, patch, sid) {
    if (delta > 60 * 4 || sid == null) {
      /* Rehost it at the highest avaliable level without overlapping anything existing. */
      function __hostit() {
        console.log('[ensureHostedByPatch]', {x: x, y: y, z: z, mxyz: mxyz, zid: zid, patch: patch});
        hurt.util.startPatchHosting(state, zid, [patch], mxyz, function (success, address) {
          /* We should have an address and a success code. */
          cb(success, address, sid);        
         });
      }
      __hostit();      
      return;
    }

    /* Try to send a message to the slave and check if this is actually up and alive. */
    hurt.slaveman.sendjson(sid, {
      subject:        'ping',
      zid:            zid,
    }, function (msg, success) {
      /*
        Either the message failed to deliver, or the actual zone-host
        was not up.

        TODO: improve the information returned and the decision making process
      */
      if (!success || !msg.zoneup) {
        /*
          We can consider it dead.
        */
        __hostit();
        return;
      }
      cb(true, address, sid);
    }, 5000); // TODO: think about making this a longer amount of time
              // TODO: this is a site of potential problems
  });
};

hurt.util.startPatchHosting = function (state, zid, patches, mxyz, cb) {
  console.log('startPatchHosting', {
    zid:     zid,
    patches: patches,
  });
  var trans = state.db.transaction();
  trans.add(
      'INSERT INTO patch_host (zid, address, lastalive, up, locked, state) VALUES (?, ?, ?, ?, ?, ?)',
      [zid, null, null, 0, 0, ''],
      'r'
  );
  trans.add('SELECT LAST_INSERT_ID() as patch_host_id', [], 'phi');
  trans.execute(function (t) {
    if (t.results.r.err) {
      t.rollback();
      cb(false);
      return;
    }
    t.commit();

    var phi = t.results.phi.rows[0].patch_host_id;
    console.log('[startPatchHosting]', { patch_host_id: phi });
    hurt.util.startPatchHostingWithPatchHostID(state, zid, patches, mxyz, phi, cb);
  });
};

hurt.util.startPatchHostingWithPatchHostID = function (state, zid, patches, mxyz, patch_host_id, cb) {
  var trans = state.db.transaction();
  trans.add('SELECT up, locked, address, sid FROM slaves', [], 'r');
  trans.execute(function (t) {
    var rows = t.results.r.rows;
    console.log('looking for slave to host zone patches', zid, patch_host_id, patches);
    console.log(rows);
    function __find_slave(x) {
      for (; x < rows.length; ++x) {
        if (rows[x].up[0] == 1 && rows[x].locked[0] == 0) {
          /*
            We need to request that the slave host this zone,
            and also get validation that the zone is hosted.
          */

          function __inner0(row) {
            return function (msg) {
              if (msg && msg.success) {
                console.log('zone is hosted');
                hurt.util.setPatchTreeLeafByPatches(state, zid, patches, mxyz, patch_host_id, function () {
                  var trans = state.db.transaction();
                  /*
                    Now update the patch host record so everyone knows that it is online and ready.
                  */
                  trans.add(
                    'UPDATE patch_host SET slaveid = ?, address = ?, lastalive = ?, up = ?  WHERE patch_host_id = ?',
                    [row.sid, row.address, (new Date()).getTime(), 1, patch_host_id],
                    'r'
                  );
                  trans.execute(function (t) {
                    if (t.results.r.err) {
                      cb(false);
                      return;
                    }
                    cb(true, row.address, row.sid);
                  });
                });
                return;
              } else {
                __find_slave(x + 1);
              }
            };
          }


          hurt.slaveman.updateAddress(rows[x].sid, rows[x].address);
          console.log('[index-server] requesting slave to host zone-patch', rows[x].address, patch_host_id);
          hurt.slaveman.sendjson(rows[x].sid, {
            subject:        'host-zone-request',
            zid:            zid,
            patch_host_id:  patch_host_id,
          }, __inner0(rows[x])); 
          return;
        }
      }
      /*
        We exhausted all slaves and none could host the zone.
      */
      console.log('slaves exhausted looking for host for zone ' + zid);
      cb(false);
    }
    __find_slave(0);
  });
};

hurt.util.ensureZoneCreated = function (state, zid, zstate, cb) {
	var trans = state.db.transaction();

	/*
		If this happens it was because this is *like* dead code. It just
		gets called incase we ever do want to give it a state here on the
		index server.
	*/
	if (!zstate) {
		zstate = {
		};
	}

	zstate = JSON.stringify(zstate);

	trans.add('SELECT state FROM zones WHERE zid = ?', [zid], 'a');
	trans.execute(function (t) {
		var rows = t.results.a.rows;
    
		if (rows.length < 1) {
      console.log('[index-server] creating zone from scratch', zid);
			var trans = state.db.transaction();
			trans.add('INSERT INTO zones (zid, state) VALUES (?, ?)', [zid, zstate], 'r');
			/*
				Execute as a high priority so we do not have our lock released.
			*/
			trans.execute(function (t) {
        if (t.results.r.err) {
          console.log('[index-server] Opps.. zone already creating.. repeating ensureZoneCreated');
          hurt.util.ensureZoneCreated(state, zid, zstate, cb);
        }
        console.log('zone created', zstate);
				trans.commit();
        cb(zstate);
			}, true);
      return;
		}

		cb(rows[0].state);
	});
};

hurt.masterindexstart = function (cfg) {
	var state = {
		cfg: 		cfg,
		uid:        100
	};


	/*
		This handles messages from slaves generally in response
		to requests that we make which arrive asynchronously from
		when we send them.
	*/
	hurt.slaveman = new slaveman();

	/*
		This handles non-web socket requests.
	*/
	http.createServer(function (req, res) {
	    httphandler.handlerL0(state, req, res);
	}).listen(45600);

	/*
		We can expect connections from anything over web socket here.
	*/
	var WebSocketServer = ws.Server;
	var wss = new WebSocketServer({
		port: 45601
	});

	state.clients = {};

	dbjuggle.opendatabase(state.cfg.db, function (err, db) {
		/*
			This will make sure that our DB does not get
			released when this function exits. We are now
			responsible for manual release.
		*/
		state.db = db;
		db.acquire();

		wss.on('connection', function (ws) {
			ws.uid = state.uid++;
			state.clients[ws.uid] = ws;

			console.log('new socket as ' + ws.uid);

			ws.sendjson = function (obj) {
				console.log('sending message on socket to ' + ws.uid);
				this.send(JSON.stringify(obj));
			};

      ws.on('error', function (er) {
        console.log('client dropped by error', state.clients[this.uid]);
        delete state.clients[this.uid];
      });

			ws.on('message', function (msg) {
				try {
					msg = JSON.parse(msg);
				} catch (err) {
					/*
						TODO: add code to report error to client and server log
					*/
					return;
				}

				switch (msg.subject) {
					case 'login':
						var user = msg.user;
						var passhash = msg.passhash;
						/*
							Validate their login then try to get them linked
							to their machine and the zone server needed. We
							might even need to make a new machine instance if
							we can not find one.
						*/
						var __disjoint_work1 = function (uid, mid, zid, mstate) {
							var __disjoint_phase1 = function (mstate, zstate) {
                /*
                  We need to ensure that the zone is currently hosted. If it
                  is not hosted then we need to start an instance of the zone
                  and wait until it is ready for connections. Then we need to
                  direct the client to connect to this zone instance.
                */
                console.log('mstate', mstate);
                mstate = JSON.parse(mstate);
                zstate = JSON.parse(zstate);

                console.log('@@@zstate', zstate, zstate.mxyz);
                hurt.util.ensureHostedByPatch(
                    state, zid, mstate.x, mstate.y, mstate.z, zstate.mxyz,
                    function (isHosted, address, sid) {
                      if (isHosted) {
                        console.log('ACCEPTED');
                        ws.sendjson({
                          subject:  'login-accepted',
                          uid:      uid,
                          mid:      mid,
                        });
                        ws.sendjson({
                          subject:  'zone-change',
                          zid:      zid,
                          address:  address
                        });
                        /*
                          This machine may already been loaded, but let us
                          send this command to ensure that it is loaded. If
                          the machine is already loaded it will just fail.
                        */
                        console.log('sid', sid);
                        hurt.slaveman.sendjson(sid, {
                          subject:        'create-machine-instance',
                          zid:            zid,
                          mid:            mid,
                          recreate:       false,
                        }); 
                        return;
                      }

                      console.log('REJECTED');
                      ws.sendjson({
                        subject: 'login-rejected',
                        desc:    'Unable to get zone hosted your avatar machine is located in.'
                      });
                    });
							}

							/*
								Get the zone that the machine is in. If no
								zone can be found then create one and in
								just a moment we will try to host it.

								TODO: set machine ID here??
								Also make sure machine ID is set for the user.
							*/
							//var trans = db.transaction();
							//trans.add('UPDATE users SET mid = ?', [mid]);
							//trans.execute(function (t) {
							zstate = hurt.util.ensureZoneCreated(state, zid,
								/*
									We can set the initial properties
									of the zone here, but if we do not
									the it will happen in the slave or
									zonehost later.
								*/
                {
                  mxyz:     2883584000,  /* 100 cubic miles (see common.js) */
                },
							  function (zstate) {
                  /*
                    We also have the zstate that was either from above if it
                    was created, or what the actual state was. We need the
                    `mxyz` parameter in order to locate the zone-host that is
                    hosting the patch the machine is located on.
                  */
                console.log('[index-server] zone creaton ensured');
								__disjoint_phase1(mstate, zstate);
							});
              /* [control released back to caller] */
						}
						/*
							TODO: add password hash validation

							I have left this open for testing.
						*/
						var trans = db.transaction();
						trans.add('SELECT uid, mid FROM users WHERE user = ?', [user], 'a');
						trans.execute(function (t) {
							var result = t.results.a.rows;

							if (result.length < 1) {
								/*
									For testing allow creation of any user.
								*/
								var mstate = {
									hull_integrity:    1.0,
									energy_stored:     100.0,
									x:                 0.0,
									y:                 0.0,
									z:           	     0.0,
                  __create_instance: true,
								};

								var trans = db.transaction();
								trans.add('INSERT INTO machines (zid, state, lastupdate) VALUES (?, ?, ?);',
									[0, JSON.stringify(mstate), 0]
								);
								trans.add('SELECT LAST_INSERT_ID() AS mid;', [], 'midres');
								trans.add('INSERT INTO users (mid, user, hash, smsphone) VALUES (LAST_INSERT_ID(), ?, ?, ?);',
									[user, '<testing>', '<none>']
								);
								trans.add('SELECT LAST_INSERT_ID() AS uid;', [], 'uidres');
								trans.execute(function (t) {
									var uid = t.results.uidres.rows[0].uid;
									var mid = t.results.midres.rows[0].mid;

									console.log('created user:' + user + ' as ' + uid + ' with machine ' + mid);

									t.commit();

									__disjoint_work1(uid, mid, 0, mstate);
								});

								//ws.sendjson({
								//	subject:    'login-rejected',
								//	desc:   'The user was not found'
								//});
								return;
							}

							var uid = result[0].uid;
							var mid = result[0].mid; 
							console.log('user and machine existing', uid, mid, result);

              /* Fetch machine state */
              var trans = db.transaction();
              trans.add('SELECT state, zid FROM machines WHERE mid = ?', [mid], 'r');
              trans.execute(function (t) {
                if (t.results.r.rows.length < 1) {
                  ws.sendjson({
                    subject:    'login-rejected',
                    desc:       'Internal Error: The machine could not be located.',
                  });
                  return;
                }
  							__disjoint_work1(uid, mid, t.results.r.rows[0].zid, t.results.r.rows[0].state);
              });
						});
				}
			});

			ws.on('close', function () {
				delete state.clients[ws.uid];
			});
		});
	});
};

var db = {
    type:     'mysql',
    host:     'kmcg3413.net',
    dbname:   'hurt',
    user:     'hurt',
    pass:     'kxmj48dhxnzhsDxnMXJS3l'
};

hurt.masterindexstart({
	challenge_request_hash:     'o3p$IejdXm2n3#',
	challenge_response_hash:    'kxj39$kejdXMs',
	db: db
});

console.log('starting the slave');

var slave = new Slave({
	db:       db,
	port:     4500,
	sid:      210000,
	address:  'ws://localhost:4500'
});
