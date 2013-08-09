/*
 * Copyright 2013 Jive Software
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *       http://www.apache.org/x    licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

var jive = require('../../../api');
var kue = require('kue');
var express = require('express');
var q = require('q');
var worker = require('./worker');
var redis = require('redis');

var jobs;
var redisClient;

var jobQueueName = 'work';
var pushQueueName = 'push';
var scheduleLocalTasks = false;
var localTasks = {};

function Scheduler(options) {
}

module.exports = Scheduler;

///////////////////////////////////////////////////////////////////////////////////////////////
// private helpers

var queueFor = function(eventID) {
    if (jive.events.pushQueueEvents.indexOf(eventID) != -1 ) {
        return pushQueueName;
    } else {
        return jobQueueName;
    }
};

var removeJob = function( job ) {
    var deferred = q.defer();
    job.remove(function() {
        jive.logger.info('job', job.id, job['data']['eventID'], 'expired, removed');
        deferred.resolve();
    });

    return deferred.promise;
};

var searchForJobs = function( queueName, eventID ) {
    var deferred = q.defer();
    var foundJobs = [];
    kue.Job.rangeByType(queueName, 'delayed', 0, 100000, 'asc', function (err, delayedJobs) {
        if ( delayedJobs ) {
            if ( eventID ) {
                delayedJobs.forEach( function(job) {
                    if ( job['data']['eventID'] == eventID ) foundJobs.push(job )
                });
            } else {
                foundJobs = foundJobs.concat( delayedJobs );
            }
        }
        kue.Job.rangeByType(queueName, 'active', 0, 100000, 'asc', function (err, activeJobs) {
            activeJobs = activeJobs || [];

            var promises = [];

            activeJobs.forEach( function(job) {
                if ( !eventID || eventID == job['data']['eventID'] ) {
                    var elapsed = ( new Date().getTime() - job.updated_at ) / 1000;
                    if ( elapsed > 20 && job.data.eventID != 'jive.reaper') {
                        // jobs shouldn't be inactive for more than 20 seconds
                        promises.push( removeJob( job ));
                    } else {
                        foundJobs.push( job );
                    }
                }
            });

            if ( promises.length > 0 ) {
                q.all(promises).finally( function() {
                    deferred.resolve( foundJobs );
                });
            } else {
                deferred.resolve( foundJobs );
            }
        });
    });
    return deferred.promise;
};

var setupKue = function(options) {
    //set up kue, optionally with a custom redis location.
    redisClient = new worker().makeRedisClient(options);
    kue.redis.createClient = function() {
        return new worker().makeRedisClient(options);
    };
    jobs = kue.createQueue();
    jobs.promote(1000);
    return options;
};

var scheduleLocalRecurrentTask = function(delay, self, eventID, context, interval, timeout) {
    if ( !scheduleLocalTasks ) {
        return;
    }

    if ( localTasks[eventID] ) {
        jive.logger.debug("Event", eventID, "already scheduled, skipping.");
        return;
    }

    // evaluate the event last ran; if its before interval is up
    // then prevent locally scheduled job from being scheduled
    var execute = function() {
        redisClient.get( eventID + ':lastrun', function(err, result) {
            var now = new Date().getTime();
            var elapsed = now - result;
            if ( err || !result || ( elapsed >= interval ) ) {
                self.isScheduled(eventID).then(function (scheduled) {
                    if (!scheduled) {
                        jive.logger.info('scheduling', eventID);
                        var schedule = self.schedule(eventID, context, undefined, undefined, true, timeout);
                        if ( schedule ) {
                            schedule.then( function(result) {
                                jive.logger.info('job', eventID,'done');
                            }, function(err) {
                                jive.logger.debug("job " + eventID, " failed: " + err);
                            }).finally( function() {
                                setTimeout( execute, interval );
                            });
                        } else {
                            setTimeout( execute, interval );
                        }
                    } else {
                        jive.logger.debug("Skipping schedule of " + eventID, " - Already scheduled");
                        setTimeout( execute, interval );
                    }
                });
            } else {
                setTimeout( execute, interval );
            }
        });
    };

    setTimeout(function () {
        execute();
    }, delay || interval || 1);

    localTasks[eventID] = true;
};

function setupCleanupTasks(_eventHandlerMap) {
    // kue specific cleanup job that should run periodically
    // to reap the job result records in redis
    _eventHandlerMap['jive.reaper'] = function() {
        var deferred = q.defer();

        jive.logger.info("Running reaper");
        kue.Job.rangeByState('complete', 0, 2000, 'asc', function (err, jobs) {
            var promises = [];
            if ( jobs ) {
                jobs.forEach( function(job) {
                    var elapsed = ( new Date().getTime() - job.created_at ) / 1000;
                    if ( elapsed > 30) {
                        // if completed more than 5 seconds ago, nuke it
                        promises.push( removeJob(job) );
                    }
                });
            }

            if ( promises.length > 0 ) {
                q.all(promises).then( function() {
                    jive.logger.info("Cleaned up", promises.length);
                }).finally(function() {
                    deferred.resolve();
                });
            } else {
                jive.logger.info("Cleaned up nothing");
                deferred.resolve();
            }
        });

        return deferred;
    };
}

///////////////////////////////////////////////////////////////////////////////////////////////
// public

Scheduler.prototype.init = function init( _eventHandlerMap, serviceConfig ) {
    var self = this;
    var isWorker = !serviceConfig || !serviceConfig['role'] || serviceConfig['role'] === jive.constants.roles.WORKER;
    var isPusher = !serviceConfig || !serviceConfig['role'] || serviceConfig['role'] === jive.constants.roles.PUSHER;

    var opts = setupKue(serviceConfig);
    if (!(isPusher || isWorker)) {
        // schedule no workers to listen on queued events if neither pusher nor worker
        return;
    }

    setupCleanupTasks(_eventHandlerMap);

    if ( isWorker ) {
        opts['queueName'] = jobQueueName;
        new worker().init(_eventHandlerMap, opts);
    }

    if ( isPusher ) {
        opts['queueName'] = pushQueueName;
        new worker().init(_eventHandlerMap, opts);
    }

    scheduleLocalTasks = isWorker;

    // setup listeners
    jive.events.globalEvents.forEach( function(event) {
        jive.events.addLocalEventListener( event, function(context ) {
            self.schedule( event, context );
        });
    });

    // schedule a periodic repear task
    self.schedule('jive.reaper', {}, 10 * 1000, undefined, false, 300 * 1000 );

    jive.logger.info("Redis Scheduler Initialized for queue");
};

/**
 * Schedule a task.
 * @param eventID the named event to fire to perform this task
 * @param context arguments to provide to the event handler
 * @param interval optional, time until this event should be fired again
 *
 * Returns a promise that gets invoked when the scheduled task has completed execution
 * only if its not a recurrent task
 */
Scheduler.prototype.schedule = function schedule(eventID, context, interval, delay, exclusive, timeout) {
    var self = this;
    context = context || {};

    if ( interval ) {
        // if there is an interval, try to execute this task periodically
        // it will only fire if it isn't already running somewhere
        scheduleLocalRecurrentTask(delay, self, eventID, context, interval, timeout);
        return q.resolve();
    }

    var deferred = q.defer();

    var jobID = jive.util.guid();
    var meta = {
        'jobID' : jobID,
        'eventID' : eventID,
        'context' : context
    };
    if (interval) {
        meta['interval'] = interval;
    }
    if ( delay ) {
        meta['delay'] = delay;
    }
    if ( exclusive ) {
        meta['exclusive'] = true;
    }
    if ( timeout ) {
        meta['timeout'] = timeout;
    }

    var job = jobs.create(queueFor(eventID), meta);
    if ( interval || delay ) {
        job.delay(interval && !delay ? interval : delay);
    }

    var timeoutWatcher = setTimeout( function() {
        // jobs should not take more than 5 minutes
        jive.logger.debug("Failed jobID " + jobID + " eventID " + eventID + " due to timeout");
        job.failed();

        deferred.resolve();
    }, timeout || (60 * 1000) );

    job.on('complete', function() {
        // once the job is done, retrieve any results that were cached on redis by some worker
        // then resolve or reject the promise accordingly.

        clearTimeout( timeoutWatcher );

        kue.Job.get( job.id, function( err, latestJobState ) {

            if ( !latestJobState ) {
                deferred.resolve();
                return;
            }

            var jobResult = latestJobState['data']['result'];
            if ( !err ) {
                deferred.resolve( jobResult ? jobResult['result'] : null );
            } else {
                if ( !jobResult ) {
                    deferred.resolve();
                } else {
                    var parsed = JSON.parse(jobResult);
                    if ( parsed['err'] ) {
                        deferred.reject(  parsed['err'] );
                    } else {
                        deferred.resolve( parsed['result']);
                    }
                }
            }
        });
    });

    jive.logger.debug("Scheduled task: " + eventID, interval || '(no interval)');
    job.save();

    return deferred.promise;
};

Scheduler.prototype.unschedule = function unschedule(eventID){
    clearInterval(localTasks[eventID]);

    this.getTasks().forEach(function(job) {
        if (job.data['eventID'] == eventID) {
            job.remove();
        }
    });
};

/**
 * Returns a promise indicating if the event is already scheduled
 * @param eventID
 */
Scheduler.prototype.isScheduled = function(eventID) {
    var deferred = q.defer();

    this.getTasks().then( function( tasks ) {
        var found = false;
        for ( var i = 0; i < tasks.length; i++ ) {
            var job = tasks[i];
            if (job.data['eventID'] == eventID) {
                found = true;
                break;
            }
        }
        deferred.resolve( found );
    });

    return deferred.promise;
};

/**
 * Returns a promise which resolves with the jobs currently scheduled (recurrent or dormant)
 */
Scheduler.prototype.getTasks = function getTasks(eventID) {
    var foundJobs = [];

    return q.all( [  searchForJobs(jobQueueName, eventID), searchForJobs(pushQueueName, eventID) ])
    .then( function( jobs ) {
        jobs.forEach( function(jobList) {
            if ( jobList && jobList.length > 0 ) {
                foundJobs = foundJobs.concat( jobList );
            }
        });

        return foundJobs;
    });
};

Scheduler.prototype.shutdown = function(){
    var scheduler = this;
    this.getTasks().forEach(function(job){
        scheduler.unschedule(job);
    });
};
