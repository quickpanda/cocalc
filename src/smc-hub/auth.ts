//#############################################################################
//
//    CoCalc: Collaborative Calculation in the Cloud
//
//    Copyright (C) 2016, Sagemath Inc.
//
//    This program is free software: you can redistribute it and/or modify
//    it under the terms of the GNU General Public License as published by
//    the Free Software Foundation, either version 3 of the License, or
//    (at your option) any later version.
//
//    This program is distributed in the hope that it will be useful,
//    but WITHOUT ANY WARRANTY; without even the implied warranty of
//    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//    GNU General Public License for more details.
//
//    You should have received a copy of the GNU General Public License
//    along with this program.  If not, see <http://www.gnu.org/licenses/>.
//
//##############################################################################

/*
Passport Authentication (oauth, etc.)

Server-side setup
-----------------

In order to get this running, you have to manually setup each service.
That requires to register with the authentication provider, telling them about CoCalc,
the domain you use, the return path for the response, and adding the client identification
and corresponding secret keys to the database.
Then, the service is active and will be presented to the user on the sign up page.
The following is an example for setting up google oauth.
The other services are similar.

1. background: https://developers.google.com/identity/sign-in/web/devconsole-project
2. https://console.cloud.google.com/apis/credentials/consent
3. https://console.developers.google.com/apis/credentials → create credentials → oauth, ...
4. The return path for google is https://{DOMAIN_NAME}/auth/google/return
5. When done, there should be an entry under "OAuth 2.0 client IDs"
6. ... and you have your ID and secret!

Now, connect to the database, where the setup is in the passports_settings table:

1. there sould be a site_conf entry:
```
insert into passport_settings (strategy , conf ) VALUES ( 'site_conf', '{"auth": "https://[DOMAIN_NAME]/auth"}'::JSONB );
```
e.g., {"auth": "https://cocalc.com/auth"} is used on the live site
and   {"auth": "https://cocalc.com/[project_id]/port/8000/auth"} for a certain dev project.

2. insert into passport_settings (strategy , conf ) VALUES ( 'google', '{"clientID": "....apps.googleusercontent.com", "clientSecret": "..."}'::JSONB )

Then restart the hubs.
*/

// Set the site conf like this:
//
//  require 'c'; db()
//  db.set_passport_settings(strategy:'site_conf', conf:{auth:'https://cocalc.com/auth'}, cb:done())
//
//  or when doing development in a project  # TODO: far too brittle, especially the port/base_url stuff!
//
//  db.set_passport_settings(strategy:'site_conf', conf:{auth:'https://cocalc.com/project_uuid.../port/YYYYY/auth'}, cb:done())

import { Router } from "express";
import { callback2 } from "../smc-util/async-utils";
import * as uuid from "node-uuid";
import * as winston from "winston";
import * as passport from "passport";
import * as dot from "dot-object";
const misc = require("smc-util/misc");
import message from "smc-util/message"; // message protocol between front-end and back-end
const { sign_in } = require("./sign-in");
import Cookies from "cookies";
import * as express_session from "express-session";
import { HELP_EMAIL } from "smc-util/theme";
import {
  email_verified_successfully,
  email_verification_problem,
  welcome_email,
} from "./email";
import { PostgreSQL } from "./postgres/types";

const { defaults, required } = misc;

const api_key_cookie_name = (base_url) => base_url + "get_api_key";

// Nov'19: actually two cookies due to same-site changes.
// See https://web.dev/samesite-cookie-recipes/#handling-incompatible-clients
export const remember_me_cookie_name = (base_url, legacy?) =>
  `${base_url}remember_me${!!legacy ? "-legacy" : ""}`;

//#######################################
// Password hashing
//#######################################

const password_hash_library = require("password-hash");
const crypto = require("crypto");

// You can change the parameters at any time and no existing passwords
// or cookies should break.  This will only impact newly created
// passwords and cookies.  Old ones can be read just fine (with the old
// parameters).
const HASH_ALGORITHM = "sha512";
const HASH_ITERATIONS = 1000;
const HASH_SALT_LENGTH = 32;

// This function is private and burried inside the password-hash
// library.  To avoid having to fork/modify that library, we've just
// copied it here.  We need it for remember_me cookies.
export function generate_hash(algorithm, salt, iterations, password): string {
  // there are cases where createHmac throws an error, because "salt" is undefined
  if (algorithm == null || salt == null) {
    throw new Error(
      `undefined arguments: algorithm='${algorithm}' salt='${salt}'`
    );
  }
  iterations = iterations || 1;
  let hash = password;
  for (
    let i = 1, end = iterations, asc = 1 <= end;
    asc ? i <= end : i >= end;
    asc ? i++ : i--
  ) {
    hash = crypto.createHmac(algorithm, salt).update(hash).digest("hex");
  }
  return algorithm + "$" + salt + "$" + iterations + "$" + hash;
}

export function password_hash(password): string {
  // This blocks the server for about 5-9ms.
  return password_hash_library.generate(password, {
    algorithm: HASH_ALGORITHM,
    saltLength: HASH_SALT_LENGTH,
    iterations: HASH_ITERATIONS,
  });
}

async function create_account(opts, email_address): Promise<string> {
  return await callback2(opts.database.create_account, {
    first_name: opts.first_name,
    last_name: opts.last_name,
    email_address,
    PassportStrategy: opts.strategy,
    passport_id: opts.id,
    passport_profile: opts.profile,
  });
}

interface PassportLogin {
  strategy: string;
  profile: any; // complex object
  id: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  emails?: string[];
  req: any;
  res: any;
  base_url: string;
  host: any;
  cb: (err) => void;
}

// maps the full profile object to a string or list of strings (e.g. "first_name")
type LoginInfoDerivator<T> = (profile: any) => T;

interface StrategyConf {
  strategy: string;
  PassportStrategy: any;
  extra_opts?: {
    enableProof?: boolean;
  };
  auth_opts?: {
    scope?: string | string[];
  };
  // return type has to partially fit with passport_login
  login_info: {
    id: string | LoginInfoDerivator<string>; // id is required!
    first_name?: string | LoginInfoDerivator<string>;
    last_name?: string | LoginInfoDerivator<string>;
    full_name?: string | LoginInfoDerivator<string>;
    emails?: string | LoginInfoDerivator<string[]>;
  };
}

// docs for getting these for your app
// https://developers.google.com/accounts/docs/OpenIDConnect#appsetup
//
// You must then put them in the database, via
//
// require 'c'; db()
// db.set_passport_settings(strategy:'google', conf:{clientID:'...',clientSecret:'...'}, cb:console.log)

// Scope:
// Enabling "profile" below I think required that I explicitly go to Google Developer Console for the project,
// then select API&Auth, then API's, then Google+, then explicitly enable it.  Otherwise, stuff just mysteriously
// didn't work.  To figure out that this was the problem, I had to grep the source code of the passport-google-oauth
// library and put in print statements to see what the *REAL* errors were, since that
// library hid the errors (**WHY**!!?).
const GoogleStrategyConf: StrategyConf = {
  strategy: "google",
  PassportStrategy: require("@passport-next/passport-google-oauth2").Strategy,
  auth_opts: { scope: "openid email profile" },
  login_info: {
    id: (profile) => profile.id,
    first_name: (profile) => profile.name.givenName,
    last_name: (profile) => profile.name.familyName,
    emails: (profile) => profile.emails.map((x) => x.value as string),
  },
};

// Get these here:
//      https://github.com/settings/applications/new
// You must then put them in the database, via
//   db.set_passport_settings(strategy:'github', conf:{clientID:'...',clientSecret:'...'}, cb:console.log)

const GithubStrategyConf: StrategyConf = {
  strategy: "github",
  PassportStrategy: require("passport-github").Strategy,
  login_info: {
    id: (profile) => profile.id,
    full_name: (profile) =>
      profile.name || profile.displayName || profile.username,
    emails: (profile) => (profile.emails ?? []).map((x) => x.value),
  },
};

// Get these by going to https://developers.facebook.com/ and creating a new application.
// For that application, set the url to the site CoCalc will be served from.
// The Facebook "App ID" and is clientID and the Facebook "App Secret" is the clientSecret
// for oauth2, as I discovered by a lucky guess... (sigh).
//
// You must then put them in the database, via
//   db.set_passport_settings(strategy:'facebook', conf:{clientID:'...',clientSecret:'...'}, cb:console.log)

const FacebookStrategyConf: StrategyConf = {
  strategy: "facebook",
  PassportStrategy: require("passport-facebook").Strategy,
  extra_opts: {
    enableProof: false,
  },
  login_info: {
    id: (profile) => profile.id,
    full_name: (profile) => profile.displayName,
  },
};

// Get these by:
//    (1) Go to https://apps.twitter.com/ and create a new application.
//    (2) Click on Keys and Access Tokens
//
// You must then put them in the database, via
//   db.set_passport_settings(strategy:'twitter', conf:{clientID:'...',clientSecret:'...'}, cb:console.log)

const TwitterStrategyConf: StrategyConf = {
  strategy: "twitter",
  PassportStrategy: require("passport-twitter").Strategy,
  login_info: {
    id: (profile) => profile.id,
    full_name: (profile) => profile.displayName,
  },
};

//const Oauth2StrategyConf: StrategyConf = {
//  strategy: "oauth2",
//  PassportStrategy: require("@passport-next/passport-oauth2").Strategy,
//  login_info: {
//      id: "id"
//    };
//  }
//};

interface InitPassport {
  router: Router;
  database: PostgreSQL;
  base_url: string;
  host: string;
  cb: (err?) => void;
}

export async function init_passport(opts: InitPassport) {
  opts = defaults(opts, {
    router: required,
    database: required,
    base_url: required,
    host: required,
    cb: required,
  });

  const pp_initializer = new PassportManager(opts);
  try {
    await pp_initializer.init();
    opts.cb();
  } catch (err) {
    opts.cb(err);
  }
}

interface PassportManagerOpts {
  router: Router;
  database: PostgreSQL;
  base_url: string;
  host: string;
}

// passport_login state
interface PassportLoginLocals {
  dbg: (m: string) => void;
  account_id: string | undefined;
  email_address: string | undefined;
  new_account_created: boolean;
  has_valid_remember_me: boolean;
  target: string;
  cookies: any;
  remember_me_cookie: string;
  get_api_key: string;
  action: "regenerate" | "get" | undefined;
  api_key: string | undefined;
}

class PassportManager {
  readonly router: Router;
  readonly database: PostgreSQL;
  readonly base_url: string;
  readonly host: string; // e.g. 127.0.0.1
  private strategies: string[] = []; // configured strategies listed here.
  private auth_url: string | undefined = undefined;

  constructor(opts: PassportManagerOpts) {
    const { router, database, base_url, host } = opts;
    this.handle_get_api_key.bind(this);
    this.router = router;
    this.database = database;
    this.base_url = base_url;
    this.host = host;
  }

  private async get_conf(strategy): Promise<any> {
    const dbg = (m) => winston.debug(`get_conf: ${m}`);
    try {
      const settings = callback2(this.database.get_passport_settings, {
        strategy,
      });

      if (settings != null) {
        if (strategy !== "site_conf") {
          this.strategies.push(strategy);
        }
        return settings;
      } else {
        dbg(`WARNING: passport strategy ${strategy} not configured`);
        return undefined;
      }
    } catch (err) {
      dbg(`error getting passport settings for ${strategy} -- ${err}`);
      throw err;
    }
  }

  // Define handler for api key cookie setting.
  private handle_get_api_key(req, res, next) {
    const dbg = (m) => winston.debug(`handle_get_api_key: ${m}`);
    dbg("");
    if (req.query.get_api_key) {
      const cookies = new Cookies(req, res);
      // maxAge: User gets up to 60 minutes to go through the SSO process...
      cookies.set(api_key_cookie_name(this.base_url), req.query.get_api_key, {
        maxAge: 30 * 60 * 1000,
      });
    }
    next();
  }

  async init(): Promise<void> {
    // Initialize authentication plugins using Passport
    const dbg = (m) => winston.debug(`init_passport: ${m}`);
    dbg("");

    // initialize use of middleware
    this.router.use(express_session({ secret: misc.uuid() })); // secret is totally random and per-hub session
    this.router.use(passport.initialize());
    this.router.use(passport.session());

    // Define user serialization
    passport.serializeUser((user, done) => done(null, user));
    passport.deserializeUser((user, done) => done(null, user));

    // Return the configured and supported authentication strategies.
    this.router.get("/auth/strategies", (_req, res) =>
      res.json(this.strategies)
    );

    this.router.get("/auth/verify", function (req, res) {
      const { DOMAIN_NAME } = require("smc-util/theme");
      const path = require("path").join("/", this.base_url, "/app");
      const url = `${DOMAIN_NAME}${path}`;
      res.header("Content-Type", "text/html");
      res.header("Cache-Control", "private, no-cache, must-revalidate");
      if (!(req.query.token && req.query.email)) {
        res.send("ERROR: I need email and corresponding token data");
        return;
      }
      const email = decodeURIComponent(req.query.email);
      // .toLowerCase() on purpose: some crazy MTAs transform everything to uppercase!
      const token = req.query.token.toLowerCase();
      this.database.verify_email_check_token({
        email_address: email,
        token,
        cb(err) {
          if (err) {
            res.send(email_verification_problem(url, err));
          } else {
            res.send(email_verified_successfully(url));
          }
        },
      });
    });

    this.auth_url = await (async () => {
      const site_conf = await this.get_conf("site_conf");
      if (site_conf != null) {
        return site_conf.auth;
      }
    })();

    dbg(`auth_url='${this.auth_url}'`);

    if (this.auth_url != null) {
      Promise.all([
        this.init_strategy(GoogleStrategyConf),
        this.init_strategy(GithubStrategyConf),
        this.init_strategy(FacebookStrategyConf),
        this.init_strategy(TwitterStrategyConf),
      ]);
    }
    this.strategies.sort();
    this.strategies.unshift("email");
  }

  // a generalized strategy initizalier
  private async init_strategy(strategy_config: StrategyConf): Promise<void> {
    const {
      strategy,
      PassportStrategy,
      extra_opts,
      auth_opts,
      login_info,
    } = strategy_config;
    const dbg = (m) => winston.debug(`init_strategy ${strategy}: ${m}`);
    dbg("start");
    const conf = await this.get_conf(strategy);

    if (conf == null) {
      throw Error(`init_strategy ${strategy}: conf is null`);
    }

    const opts = Object.assign(
      {
        clientID: conf.clientID,
        clientSecret: conf.clientSecret,
        callbackURL: `${this.auth_url}/${strategy}/return`,
      },
      extra_opts
    );

    const verify = (_accessToken, _refreshToken, profile, done) =>
      done(undefined, { profile });
    passport.use(new PassportStrategy(opts, verify));

    this.router.get(
      `/auth/${strategy}`,
      this.handle_get_api_key,
      passport.authenticate(strategy, auth_opts)
    );

    this.router.get(
      `/auth/${strategy}/return`,
      passport.authenticate(strategy),
      async (req, res) => {
        const { profile } = req.user;
        const login_opts = {
          strategy,
          profile, // will just get saved in database
          req,
          res,
          base_url: this.base_url,
          host: this.host,
        };
        for (const k in login_info) {
          const v = login_info[k];
          const param: string | string[] =
            typeof v == "function"
              ? // v is a LoginInfoDerivator<T>
                v(profile)
              : // v is a string for dot-object
                dot.pick(v, profile);
          Object.assign(login_opts, { [k]: param });
        }
        await this.passport_login(login_opts as PassportLogin);
      }
    );
  }

  private async passport_login(opts: PassportLogin): Promise<void> {
    opts = defaults(opts, {
      strategy: required, // name of the auth strategy, e.g., 'google', 'facebook', etc.
      profile: required, // will just get saved in database
      id: required, // unique id given by oauth provider
      first_name: undefined,
      last_name: undefined,
      full_name: undefined,
      emails: undefined, // if user not logged in (via remember_me) already, and existing account with same email, and passport not created, then get an error instead of login or account creation.
      req: required, // request object
      res: required, // response object
      base_url: "",
      host: required,
    });

    const dbg = (m) => winston.debug(`passport_login: ${m}`);
    const BASE_URL = opts.base_url;

    dbg(misc.to_json(opts.req.user));

    const cookies = new Cookies(opts.req, opts.res);

    const locals: PassportLoginLocals = {
      dbg,
      cookies,
      new_account_created: false,
      has_valid_remember_me: false,
      account_id: undefined,
      email_address: undefined,
      target: BASE_URL + "/app#login",
      remember_me_cookie: cookies.get(remember_me_cookie_name(BASE_URL)),
      get_api_key: cookies.get(api_key_cookie_name(BASE_URL)),
      action: undefined,
      api_key: undefined,
    };

    //# dbg("cookies = '#{opts.req.headers['cookie']}'")  # DANGER -- do not uncomment except for debugging due to SECURITY
    dbg(`remember_me_cookie = '${locals.remember_me_cookie}'`);

    // check if user is just trying to get an api key.
    if (locals.get_api_key) {
      dbg("user is just trying to get api_key");
      // Set with no value **deletes** the cookie when the response is set. It's very important
      // to delete this cookie ASAP, since otherwise the user can't sign in normally.
      locals.cookies.set(api_key_cookie_name(BASE_URL));
    }

    if (
      opts.full_name != null &&
      opts.first_name == null &&
      opts.last_name == null
    ) {
      const name = opts.full_name;
      const i = name.lastIndexOf(" ");
      if (i === -1) {
        opts.first_name = "";
        opts.last_name = name;
      } else {
        opts.first_name = name.slice(0, i).trim();
        opts.last_name = name.slice(i).trim();
      }
    }

    opts.first_name = opts.first_name ?? "";
    opts.last_name = opts.last_name ?? "";

    if (opts.emails != null) {
      opts.emails = (() => {
        const result: string[] = [];
        for (const x of opts.emails) {
          if (typeof x === "string" && misc.is_valid_email_address(x)) {
            result.push(x.toLowerCase());
          }
        }
        return result;
      })();
    }

    opts.id = `${opts.id}`; // convert to string (id is often a number)

    //////////////////////////////////////////////////////////////

    try {
      await this.check_remember_me_cookie(locals);
      // do we already have a passport?
      await this.check_passport_exists(opts, locals);
      // there might be accounts already with that email address
      await this.check_existing_emails(opts, locals);
      // if no account yet → create one
      await this.maybe_create_account(opts, locals);
      // record a sign-in activity, if we deal with an existing account
      await this.maybe_record_sign_in(opts, locals);
      // deal with the case where user wants an API key
      await this.maybe_provision_api_key(locals);
      // check if user is banned?
      await this.is_user_banned(locals.account_id, locals.email_address);
      //  last step: set remember me cookie (for a  new sign in)
      await this.handle_new_sign_in(opts, locals, BASE_URL);
    } catch (err) {
      if (err) {
        opts.res.send(`Error trying to login using ${opts.strategy} -- ${err}`);
      } else {
        dbg("redirect the client");
        opts.res.redirect(locals.target);
      }
    }
  } // end passport_login

  private async check_remember_me_cookie(
    locals: PassportLoginLocals
  ): Promise<void> {
    if (!locals.remember_me_cookie) return;

    locals.dbg("check if user has a valid remember_me cookie");
    const value = locals.remember_me_cookie;
    const x: string[] = value.split("$");
    if (x.length !== 4) {
      throw Error("badly formatted remember_me cookie");
    }
    let hash;
    try {
      hash = generate_hash(x[0], x[1], x[2], x[3]);
    } catch (error) {
      const err = error;
      locals.dbg(
        `unable to generate hash from remember_me cookie = '${locals.remember_me_cookie}' -- ${err}`
      );
    }
    if (hash != null) {
      const signed_in_mesg = await callback2(this.database.get_remember_me, {
        hash,
      });
      if (signed_in_mesg != null) {
        locals.dbg("user does have valid remember_me token");
        locals.account_id = signed_in_mesg.account_id;
        locals.has_valid_remember_me = true;
      } else {
        throw Error("no valid remember_me token");
      }
    }
  }

  private async check_passport_exists(
    opts: PassportLogin,
    locals: PassportLoginLocals
  ): Promise<void> {
    locals.dbg(
      "check to see if the passport already exists indexed by the given id -- in that case we will log user in"
    );

    const _account_id = await callback2(this.database.passport_exists, {
      strategy: opts.strategy,
      id: opts.id,
    });

    if (
      !_account_id &&
      locals.has_valid_remember_me &&
      locals.account_id != null
    ) {
      locals.dbg(
        "passport doesn't exist, but user is authenticated (via remember_me), so we add this passport for them."
      );
      await callback2(this.database.create_passport, {
        account_id: locals.account_id,
        strategy: opts.strategy,
        id: opts.id,
        profile: opts.profile,
        email_address: opts.emails != null ? opts.emails[0] : undefined,
        first_name: opts.first_name,
        last_name: opts.last_name,
      });
    } else {
      if (locals.has_valid_remember_me && locals.account_id !== _account_id) {
        locals.dbg(
          "passport exists but is associated with another account already"
        );
        throw Error(
          `Your ${opts.strategy} account is already attached to another CoCalc account.  First sign into that account and unlink ${opts.strategy} in account settings if you want to instead associate it with this account.`
        );
      } else {
        if (locals.has_valid_remember_me) {
          locals.dbg(
            "passport already exists and is associated to the currently logged into account"
          );
        } else {
          locals.dbg(
            "passport exists and is already associated to a valid account, which we'll log user into"
          );
          locals.account_id = _account_id;
        }
      }
    }
  }

  private async check_existing_emails(
    opts: PassportLogin,
    locals: PassportLoginLocals
  ): Promise<void> {
    // handle case where we passport doesn't exist, but we know one or more email addresses → check for matching email
    if (!(locals.account_id || opts.emails == null)) {
      locals.dbg(
        "passport doesn't exist and emails available, so check for existing account with a matching email -- if we find one it's an error"
      );

      const check_emails = opts.emails.map(async (email) => {
        if (locals.account_id) {
          locals.dbg(
            `already found a match with account_id=${locals.account_id} -- done`
          );
          return;
        } else {
          locals.dbg(`checking for account with email ${email}...`);
          const _account_id = await callback2(this.database.account_exists, {
            email_address: email.toLowerCase(),
          });
          if (locals.account_id) {
            // already done, so ignore
            locals.dbg(
              `already found a match with account_id=${locals.account_id} -- done`
            );
            return;
          } else if (!_account_id) {
            throw Error("check_email: no _account_id");
          } else {
            locals.account_id = _account_id;
            locals.email_address = email.toLowerCase();
            locals.dbg(
              `found matching account ${locals.account_id} for email ${locals.email_address}`
            );
            throw Error(
              `There is already an account with email address ${locals.email_address}; please sign in using that email account, then link ${opts.strategy} to it in account settings.`
            );
          }
        }
      });
      await Promise.all(check_emails);
    } // END: handle case where we passport doesn't exist but we know email addresses ...
  }

  private async maybe_create_account(
    opts: PassportLogin,
    locals: PassportLoginLocals
  ): Promise<void> {
    if (locals.account_id) return;

    locals.dbg(
      "no existing account to link, so create new account that can be accessed using this passport"
    );
    if (opts.emails != null) {
      locals.email_address = opts.emails[0];
    }

    locals.account_id = await create_account(opts, locals.email_address);
    locals.new_account_created = true;
    if (locals.email_address != null) {
      await callback2(this.database.do_account_creation_actions, {
        email_address: locals.email_address,
        account_id: locals.account_id,
      });
    }
    // log this
    const data = {
      account_id: locals.account_id,
      first_name: opts.first_name,
      last_name: opts.last_name,
      email_address: locals.email_address != null ? locals.email_address : null,
      created_by: opts.req.ip,
    };
    // no await -- don't let client wait for *logging* the fact that we created an account
    // failure wouldn't matter.
    this.database.log({
      event: "create_account",
      value: data,
    });
  }

  private async maybe_record_sign_in(
    opts: PassportLogin,
    locals: PassportLoginLocals
  ): Promise<void> {
    if (!locals.new_account_created) {
      // don't make client wait for this -- it's just a log message for us.
      locals.dbg(`record_sign_in: ${opts.req.url}`);
      sign_in.record_sign_in({
        ip_address: opts.req.ip,
        successful: true,
        remember_me: locals.has_valid_remember_me,
        email_address: locals.email_address,
        account_id: locals.account_id,
        database: this.database,
      });
    }
  }

  private async maybe_provision_api_key(
    locals: PassportLoginLocals
  ): Promise<void> {
    if (!locals.get_api_key) return;

    // Just handle getting api key here.
    const { api_key_action } = require("./api/manage"); // here, rather than at beginnig of file, due to some circular references...
    if (locals.new_account_created) {
      locals.action = "regenerate"; // obvious
    } else {
      locals.action = "get";
    }

    locals.api_key = await callback2(api_key_action, {
      database: this.database,
      account_id: locals.account_id,
      passport: true,
      action: locals.action,
    });

    // if there is no key
    if (!locals.api_key) {
      locals.dbg(
        "get_api_key -- must generate key, since don't already have it"
      );
      locals.api_key = await callback2(api_key_action, {
        database: this.database,
        account_id: locals.account_id,
        passport: true,
        action: "regenerate",
      });
    }
    // we got a key ...
    // NOTE: See also code to generate similar URL in smc-webapp/account/init.ts
    locals.target = `https://authenticated?api_key=${locals.api_key}`;
  }

  private async handle_new_sign_in(
    opts: PassportLogin,
    locals: PassportLoginLocals,
    BASE_URL: string
  ): Promise<void> {
    if (locals.has_valid_remember_me) return;

    // make TS happy
    if (locals.account_id == null) throw Error("locals.account_id is null");

    locals.dbg(
      "passport created: set remember_me cookie, so user gets logged in"
    );

    // create and set remember_me cookie, then redirect.
    // See the remember_me method of client for the algorithm we use.
    const signed_in_mesg = message.signed_in({
      remember_me: true,
      hub: opts.host,
      account_id: locals.account_id,
      first_name: opts.first_name,
      last_name: opts.last_name,
    });

    locals.dbg("create remember_me cookie");
    const session_id = uuid.v4();
    const hash_session_id = password_hash(session_id);
    const ttl = 24 * 3600 * 30; // 30 days
    const x: string[] = hash_session_id.split("$");
    const remember_me_value = [x[0], x[1], x[2], session_id].join("$");

    locals.dbg("save remember_me cookie in database");
    await callback2(this.database.save_remember_me, {
      account_id: locals.account_id,
      hash: hash_session_id,
      value: signed_in_mesg,
      ttl,
    });

    locals.dbg("and also set remember_me cookie in client");
    locals.cookies.set(remember_me_cookie_name(BASE_URL), remember_me_value, {
      maxAge: ttl * 1000,
    });
  }

  private async is_user_banned(account_id, email_address): Promise<boolean> {
    const is_banned = await callback2(this.database.is_banned_user, {
      account_id,
    });
    if (is_banned) {
      const settings = await callback2(
        this.database.get_server_settings_cached
      );
      const email = settings.help_email || HELP_EMAIL;
      throw Error(
        `User (account_id=${account_id}, email_address=${email_address}) is BANNED. If this is a mistake, please contact ${email}.`
      );
    }
    return is_banned;
  }
}

interface IsPasswordCorrect {
  database: PostgreSQL;
  password: string;
  password_hash?: string;
  account_id?: string;
  email_address?: string;
  allow_empty_password?: boolean;
  cb: (err?, correct?: boolean) => void;
}

// Password checking.  opts.cb(undefined, true) if the
// password is correct, opts.cb(error) on error (e.g., loading from
// database), and opts.cb(undefined, false) if password is wrong.  You must
// specify exactly one of password_hash, account_id, or email_address.
// In case you specify password_hash, in addition to calling the
// callback (if specified), this function also returns true if the
// password is correct, and false otherwise; it can do this because
// there is no async IO when the password_hash is specified.
export async function is_password_correct(
  opts: IsPasswordCorrect
): Promise<void> {
  opts = defaults(opts, {
    database: required,
    password: required,
    password_hash: undefined,
    account_id: undefined,
    email_address: undefined,
    // If true and no password set in account, it matches anything.
    // this is only used when first changing the email address or password
    // in passport-only accounts.
    allow_empty_password: false,
    // cb(err, true or false)
    cb: required,
  });

  if (opts.password_hash != null) {
    const r = password_hash_library.verify(opts.password, opts.password_hash);
    opts.cb(undefined, r);
  } else if (opts.account_id != null || opts.email_address != null) {
    try {
      const account = await callback2(opts.database.get_account, {
        account_id: opts.account_id,
        email_address: opts.email_address,
        columns: ["password_hash"],
      });

      if (opts.allow_empty_password && !account.password_hash) {
        if (opts.password && opts.account_id) {
          // Set opts.password as the password, since we're actually
          // setting the email address and password at the same time.
          opts.database.change_password({
            account_id: opts.account_id,
            password_hash: password_hash(opts.password),
            invalidate_remember_me: false,
            cb: (err) => opts.cb(err, true),
          });
        } else {
          opts.cb(undefined, true);
        }
      } else {
        opts.cb(
          undefined,
          password_hash_library.verify(opts.password, account.password_hash)
        );
      }
    } catch (error) {
      opts.cb(error);
    }
  } else {
    opts.cb(
      "One of password_hash, account_id, or email_address must be specified."
    );
  }
}

export async function verify_email_send_token(opts) {
  opts = defaults(opts, {
    database: required,
    account_id: required,
    only_verify: false,
    cb: required,
  });

  try {
    const { token, email_address } = await callback2(
      opts.database.verify_email_create_token,
      {
        account_id: opts.account_id,
      }
    );
    const settings = await callback2(opts.database.get_server_settings_cached);
    await callback2(welcome_email, {
      to: email_address,
      token,
      only_verify: opts.only_verify,
      settings,
    });
    opts.cb();
  } catch (err) {
    opts.cb(err);
  }
}