import { DEV_HOST, DEV_FRAME_HOST, PROD_HOST, API_URL, STAGING_FRAME_HOST, DEV_PREFIX, STAGING_PREFIX } from '../vars';
import Environment from '../Environment';
import OneSignalApi from '../OneSignalApi';
import * as log from 'loglevel';
import LimitStore from '../LimitStore';
import Event from "../Event";
import Database from '../Database';
import * as Browser from 'bowser';
import {
  getConsoleStyle, contains, normalizeSubdomain, getDeviceTypeForBrowser, capitalize,
  isPushNotificationsSupported
} from '../utils';
import * as objectAssign from 'object-assign';
import * as EventEmitter from 'wolfy87-eventemitter';
import * as heir from 'heir';
import * as swivel from 'swivel';
import Postmam from '../Postmam';
import * as Cookie from 'js-cookie';
import MainHelper from "./MainHelper";
import SubscriptionHelper from "./SubscriptionHelper";

declare var OneSignal: any;


export default class ServiceWorkerHelper {
  static applyServiceWorkerEnvPrefixes() {
    if (Environment.isDev()) {
      OneSignal.SERVICE_WORKER_PATH = DEV_PREFIX + 'OneSignalSDKWorker.js';
      OneSignal.SERVICE_WORKER_UPDATER_PATH = DEV_PREFIX + 'OneSignalSDKUpdaterWorker.js';
    } else if (Environment.isStaging()) {
      OneSignal.SERVICE_WORKER_PATH = STAGING_PREFIX + 'OneSignalSDKWorker.js';
      OneSignal.SERVICE_WORKER_UPDATER_PATH = STAGING_PREFIX + 'OneSignalSDKUpdaterWorker.js';
    }
  }

  static closeNotifications() {
    if (navigator.serviceWorker && !SubscriptionHelper.isUsingSubscriptionWorkaround()) {
      navigator.serviceWorker.getRegistration()
        .then(registration => {
          if (registration === undefined || !registration.active) {
            throw new Error('There is no active service worker.');
          } else if (OneSignal._channel) {
            OneSignal._channel.emit('data', 'notification.closeall');
          }
        });
    }
  }

  /*
   Updates an existing OneSignal-only service worker if an older version exists. Does not install a new service worker if none is available or overwrite other service workers.
   This also differs from the original update code we have below in that we do not subscribe for push after.
   Because we're overwriting a service worker, the push token seems to "carry over" (this is good), whereas if we unregistered and registered a new service worker, the push token would be lost (this is bad).
   By not subscribing for push after we register the SW, we don't have to care if notification permissions are granted or not, since users will not be prompted; this update process will be transparent.
   This way we can update the service worker even for autoRegister: false users.
   */
  static updateServiceWorker() {

    let updateCheckAlreadyRan = sessionStorage.getItem('onesignal-update-serviceworker-completed');
    if (!navigator.serviceWorker || !Environment.isHost() || location.protocol !== 'https:' || updateCheckAlreadyRan == "true") {
      log.debug('Skipping service worker update for existing session.');
      return;
    }

    try {
      sessionStorage.setItem('onesignal-update-serviceworker-completed', "true");
    } catch (e) {
      log.error(e);
    }

    return navigator.serviceWorker.getRegistration().then(function (serviceWorkerRegistration) {
      var sw_path = "";

      if (OneSignal.config.path)
        sw_path = OneSignal.config.path;

      if (serviceWorkerRegistration && serviceWorkerRegistration.active) {
        // An existing service worker
        let previousWorkerUrl = serviceWorkerRegistration.active.scriptURL;
        if (contains(previousWorkerUrl, sw_path + OneSignal.SERVICE_WORKER_PATH)) {
          // OneSignalSDKWorker.js was installed
          log.debug('(Service Worker Update)', 'The main service worker is active.');
          return Database.get('Ids', 'WORKER1_ONE_SIGNAL_SW_VERSION')
                         .then(function (version) {
                           // Get version of installed worker saved to IndexedDB
                           if (version) {
                             // If a version exists
                             log.debug('(Service Worker Update)', `Stored service worker version v${version}.`);
                             if (version != OneSignal._VERSION) {
                               // If there is a different version
                               log.debug('(Service Worker Update)', 'New service worker version exists:', OneSignal._VERSION);
                               log.info(`Upgrading service worker (v${version} -> v${OneSignal._VERSION})`);
                               return navigator.serviceWorker.register(sw_path + OneSignal.SERVICE_WORKER_UPDATER_PATH, OneSignal.SERVICE_WORKER_PARAM);
                             }
                             else {
                               // No changed service worker version
                               log.debug('(Service Worker Update)', 'You already have the latest service worker version.');
                               return null;
                             }
                           }
                           else {
                             // No version was saved; somehow this got overwritten
                             // Reinstall the alternate service worker
                             log.debug('(Service Worker Update)', 'No stored service worker version. Reinstalling the service worker.');
                             return navigator.serviceWorker.register(sw_path + OneSignal.SERVICE_WORKER_UPDATER_PATH, OneSignal.SERVICE_WORKER_PARAM);
                           }

                         });
        }
        else if (contains(previousWorkerUrl, sw_path + OneSignal.SERVICE_WORKER_UPDATER_PATH)) {
          // OneSignalSDKUpdaterWorker.js was installed
          log.debug('(Service Worker Update)', 'The alternate service worker is active.');
          return Database.get('Ids', 'WORKER2_ONE_SIGNAL_SW_VERSION')
                         .then(function (version) {
                           // Get version of installed worker saved to IndexedDB
                           if (version) {
                             // If a version exists
                             log.debug('(Service Worker Update)', `Stored service worker version v${version}.`);
                             if (version != OneSignal._VERSION) {
                               // If there is a different version
                               log.debug('(Service Worker Update)', 'New service worker version exists:', OneSignal._VERSION);
                               log.info(`Upgrading new service worker (v${version} -> v${OneSignal._VERSION})`);
                               return navigator.serviceWorker.register(sw_path + OneSignal.SERVICE_WORKER_PATH, OneSignal.SERVICE_WORKER_PARAM);
                             }
                             else {
                               // No changed service worker version
                               log.debug('(Service Worker Update)', 'You already have the latest service worker version.');
                               return null;
                             }
                           }
                           else {
                             // No version was saved; somehow this got overwritten
                             // Reinstall the alternate service worker
                             log.debug('(Service Worker Update)', 'No stored service worker version. Reinstalling the service worker.');
                             return navigator.serviceWorker.register(sw_path + OneSignal.SERVICE_WORKER_PATH, OneSignal.SERVICE_WORKER_PARAM);
                           }
                         });
        } else {
          // Some other service worker not belonging to us was installed
          // Don't install ours over it
        }
      }
    });
  }

  static registerServiceWorker(full_sw_and_path) {
    log.debug(`Called %cregisterServiceWorker(${JSON.stringify(full_sw_and_path, null, 4)})`, getConsoleStyle('code'));
    navigator.serviceWorker.register(full_sw_and_path, OneSignal.SERVICE_WORKER_PARAM).then(SubscriptionHelper.enableNotifications, ServiceWorkerHelper.registerError);
  }

  static registerError(err) {
    log.error("ServiceWorker registration", err);
  }

  static isServiceWorkerActive(callback?) {
    if (!isPushNotificationsSupported()) {
      return;
    }
    if (!('serviceWorker' in navigator)) {
      return false;
    }

    function isServiceWorkerRegistrationActive(serviceWorkerRegistration) {
      return serviceWorkerRegistration.active &&
        serviceWorkerRegistration.active.state === 'activated' &&
        (contains(serviceWorkerRegistration.active.scriptURL, 'OneSignalSDKWorker') ||
        contains(serviceWorkerRegistration.active.scriptURL, 'OneSignalSDKUpdaterWorker'));
    }

    return new Promise((resolve, reject) => {
      if (!SubscriptionHelper.isUsingSubscriptionWorkaround() && !Environment.isIframe()) {
        let isServiceWorkerActive = false;
        if (navigator.serviceWorker.getRegistrations) {
          navigator.serviceWorker.getRegistrations().then(serviceWorkerRegistrations => {
            for (let serviceWorkerRegistration of serviceWorkerRegistrations) {
              if (isServiceWorkerRegistrationActive(serviceWorkerRegistration)) {
                isServiceWorkerActive = true;
              }
            }
            if (callback) {
              callback(isServiceWorkerActive)
            }
            resolve(isServiceWorkerActive);
          });
        } else {
          navigator.serviceWorker.ready.then(serviceWorkerRegistration => {
            if (isServiceWorkerRegistrationActive(serviceWorkerRegistration)) {
              isServiceWorkerActive = true;
            }
            if (callback) {
              callback(isServiceWorkerActive)
            }
            resolve(isServiceWorkerActive);
          });
        }
      } else {
        if (callback) {
          callback(false)
        }
        resolve(false);
      }
    });
  }
}