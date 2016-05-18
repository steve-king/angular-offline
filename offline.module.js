/* global angular */
(function(){
    'use strict';

    var app = angular.module('Offline', [
        'LocalStorageModule',
        'Helpers'
    ])

    .config(['localStorageServiceProvider', function(localStorageServiceProvider){
        localStorageServiceProvider.setPrefix('');
    }])

    .run([function(){
    }])

    // Offline Controller
    // - Listens for Offline/Online events from the Offline service
    // - Stores state for:
    //          - Online/Offline status
    //          - Number of requests pending
    //          - Whether sync operation is in progress
    //          - Sync success / fail
    .controller('offlineController', 
                ['$scope', '$rootScope', '$timeout', 'Offline', 'debounce', 'throttle', '$window',
        function( $scope,   $rootScope,   $timeout,   Offline,   debounce,   throttle,   $window){

            $scope.offline = Offline.get();
            
            // $scope.queue = Offline.getQueue();
            // $scope.online = offlineVars.online;

            $scope.syncing = false;
            $scope.syncFailed = false;

            $rootScope.$on('CONNECTION:ONLINE', function(){

                $scope.online = true;
                $scope.message_type = 'success';
                $scope.message = $rootScope.content.status_online;
                clearMessage();

                if( Offline.get().queue.length > 0 ){
                    $timeout(function(){
                        if(!$scope.syncing && !$scope.syncFailed){
                            $scope.message = $rootScope.content.status_uploading; 
                            $timeout(function(){
                                $scope.sync();
                            }, 2000);
                        }
                    }, 2000);
                }
            });

            $rootScope.$on('CONNECTION:OFFLINE', function(){

                var showMessage = function(){
                    $scope.online = false;
                    $scope.message_type = 'error';
                    $scope.message = $rootScope.content.status_offline;
                    clearMessage();
                };

                if( $scope.syncing ){
                    $timeout(function(){
                        showMessage();
                    }, 4000);
                } else {
                    showMessage();
                }
            });

            $scope.sync = function(){
                $scope.syncFailed = false;
                $scope.syncing = true;
                Offline.syncToServer().then(
                    function(success){
                        $scope.syncing = false;
                        $scope.message_type = 'success';
                        $scope.message = success.message;
                        clearMessage();
                        $scope.syncFailed = false;
                    },
                    function(error){
                        console.log('SYNC ERROR', error);
                        $scope.syncing = false;
                        $scope.message_type = 'error';
                        $scope.message = error.message;
                        $scope.syncFailed = true;
                    }
                );
            };

            if( $scope.offline.online && $scope.offline.queue.length > 0 ){
                $scope.sync();
            }

            $rootScope.$on('UPLOAD:PROGRESS', function(e, data){
                $scope.uploadProgress = (data.uploaded / data.total) * 100;
            })

            $scope.toggleOfflineMode = function(){
                Offline.toggleOfflineMode();
            };

            var clearMessage = debounce(function(){
                $timeout(function(){
                    $scope.message = '';
               });
            }, 1500);

            $scope.showMessage = function(type, message){
                $timeout(function(){
                    $scope.message_type = type;
                    $scope.message = message;
                    clearMessage();
                });
            };

            var cacheStatus = NIKE.cacheStatus;
            $timeout(function(){
                switch( cacheStatus ){
                    case $window.applicationCache.UNCACHED:
                        $scope.showMessage('error', $rootScope.content.status_cache_disabled);
                    break;

                    case $window.applicationCache.CHECKING:
                        $scope.showMessage('success', $rootScope.content.status_cache_updating);
                    break;

                    case $window.applicationCache.UPDATEREADY:
                        $scope.showMessage('success', $rootScope.content.status_cache_ready);
                    break;

                    case $window.applicationCache.IDLE:
                        $scope.showMessage('success', $rootScope.content.status_cache_ready);
                    break;

                    // case $window.applicationCache.DOWNLOADING:
                    //     $scope.showMessage('Downloading resources...');
                    // break;
                };
            });
            

            $window.applicationCache.addEventListener('checking', function(){
                if(!$scope.cacheError){
                    $scope.showMessage('success', $rootScope.content.status_cache_updating);
                }
            }, false); 
            $window.applicationCache.addEventListener('cached', function(){
               $scope.showMessage('success', $rootScope.content.status_cache_ready);
            }, false); 
            $window.applicationCache.addEventListener('updateready', function(){
                $scope.showMessage('success', $rootScope.content.status_cache_ready);
            }, false);
            $window.applicationCache.addEventListener('uncached', function(){
                $scope.showMessage('error', $rootScope.content.status_cache_error);
            }, false);
            $window.applicationCache.addEventListener('noupdate', function(){
                $scope.showMessage('success', $rootScope.content.status_cache_ready);
            }, false);
            $window.applicationCache.addEventListener('onerror', function(){
                $scope.showMessage('error', $rootScope.content.status_cache_error);
                $scope.cacheError = true;
            }, false);

            $scope.cacheProgress = 0;
            $scope.showProgress = false;
            $scope.progressMessage = '';
            
            $window.applicationCache.addEventListener('progress', throttle(function(event) {
                $scope.$apply(function(){
                    if( !$scope.showProgress ){
                        $scope.showProgress = true;
                    }

                    $scope.cacheProgress = (event.loaded / event.total) * 100;

                    if( !$scope.message ){
                        $scope.progressMessage = $rootScope.content.status_cache_updating+event.loaded+'/'+event.total;
                        $scope.message_type = 'success';
                    } else {
                        $scope.progressMessage = '';
                    }

                    if( event.loaded === event.total ){
                        $timeout(function(){
                            $scope.showProgress = false;
                            $scope.progressMessage = '';
                        }, 200);
                    }
                });
            }, 50), false);
        }
    ])
    
    // Offline service
    // - Detects browser online/offline events
    // - Maintains a backlog of unexecuted $HTTP requests and stores their configs in LocalStorage
    // - Sync function runs each queued request one by one, and resolves a promise when sync is complete
    // - If any request in the sync loop fails due to lack of connection, the loop is stopped.
    .provider('Offline', function(){

        this.delay = 0;
        
        this.$get = ['$injector', '$q', 'localStorageService', '$timeout', '$window', '$rootScope',
        function(     $injector,   $q,   localStorageService,   $timeout,   $window,   $rootScope     ){
            
            var service = {};

            var vars = {
                userId: '',
                storageKey: 'offline.http_queue',
                delay: 0,
                queue: [],
                online: true,
            };
            // var userId, storedQueue, vars.queue = [], delay;

            service.init = function(userId, delay){
                vars.userId = userId;
                vars.delay = delay;
                vars.storageKey = vars.userId+'.'+vars.storageKey;
                var storedQueue = localStorageService.get(vars.storageKey);
                vars.queue = (storedQueue) ? storedQueue : [];
            };

            vars.online = ($window.navigator.onLine) ? true : false;

            angular.element($window).on('online', function(){
                $timeout(function(){
                    vars.online = true;
                    $rootScope.$broadcast('CONNECTION:ONLINE');
                });
            });

            angular.element($window).on('offline', function(){
                $timeout(function(){
                    vars.online = false;
                    $rootScope.$broadcast('CONNECTION:OFFLINE');
                });
            });

            service.get = function(){
                return vars;
            };

            service.isOnline = function(){
                return vars.online;
            };

            service.addToQueue = function(requestObject){

                var requestConfig = {
                    queuedRequest: true,
                    data: requestObject.data,
                    method: requestObject.method,
                    url: requestObject.url,
                    timeout: 2000
                };

                vars.queue.push(requestConfig);
                localStorageService.set(vars.storageKey, vars.queue);
                // console.log('addedToQueue', vars.queue);
            };


            service.syncToServer = function(){
                var total = vars.queue.length;
                var uploaded = 0;

                var deferred = $q.defer();

                var $http = $injector.get('$http');

                var syncNext = function(){
                    if( vars.online ){

                        if( vars.queue.length > 0 ){
                            $timeout(function(){
                                execute(vars.queue[0]);
                            }, vars.delay);
                        } 

                        if( vars.queue.length === 0 ){
                            localStorageService.remove(vars.storageKey);
                            deferred.resolve({
                                success: true,
                                message: $rootScope.content.status_upload_success
                            });
                        }

                    } else {
                        deferred.reject({
                            success: false,
                            message: $rootScope.content.status_upload_failed
                        });
                    }
                };
                
                var execute = function(requestConfig){
                    $http(requestConfig).then(
                        function(response){
                            vars.queue.shift();
                            localStorageService.set(vars.storageKey, vars.queue);
                            uploaded ++;
                            $rootScope.$broadcast('UPLOAD:PROGRESS', {
                                total: total,
                                uploaded: uploaded
                            });
                            syncNext();
                        },
                        function(error){
                            if( error.status === -1 ){
                                //service.online = false;
                                // STOP!
                                localStorageService.set(vars.storageKey, vars.queue);

                                deferred.reject({
                                    success: false,
                                    message: $rootScope.content.status_upload_failed
                                });
                            } else {
                                vars.queue.shift();
                                localStorageService.set(vars.storageKey, vars.queue);
                                syncNext();
                            }
                            console.log('Queued request error:', error);
                            
                        }
                    );
                };    

                if( total > 0 ){
                    syncNext();
                } else {
                    localStorageService.remove(vars.storageKey);
                    deferred.resolve({
                        success: true,
                        message: 'Nothing to upload'
                    });
                }

                return deferred.promise;
            };

            return service;
        }];
    })
    
    // Offline Interceptor
    // - Hijacks any request whose URL matches a substring in the config
    // - When device is offline, blocks the request and adds it to the queue
    .provider('OfflineInterceptor', function(){
        
        // Config 
        // - requires a string or array of substrings
        // - We will check this array to see if the incoming $HTTP request should be acted upon.
        var matches = [];
        this.match = function(arrayOrString){
            matches = matches.concat(arrayOrString);
        };

        this.$get = ['Offline', '$q', '$timeout', 'localStorageService',
            function( Offline,   $q,   $timeout,   localStorageService ){
                
                // Checks string for matches against substring array
                function containsAny(substrings, string){
                    for (var i = 0; i !== substrings.length; i++) {
                        var substring = substrings[i];
                            if (string.indexOf(substring) !== - 1) {
                            return substring;
                        }
                    }
                    return false; 
                }

                return {
                    request: function(config){

                        // If this request was already queued let's pass it straight through
                        if( config.queuedRequest ){
                            return config;
                        }

                        // We're offline and we have a match. Add a copy of the request to the Offline queue and reject (error) this request
                        if( !Offline.get().online && containsAny(matches, config.url) ){
                            
                            var deferred = $q.defer();

                            var _config = angular.copy(config);
                            Offline.addToQueue( _config );

                            config.status = -1;
                            config.statusText = 'Browser currently offline. This request has been queued for later.';
                            deferred.reject(config);

                            return deferred.promise;

                        } else {
                            return config;
                        }
                    },
                    requestError: function(requestError){
                        console.log('REQUEST_ERROR', requestError);
                    },
                    response: function(successResponse){
                        var deferred = $q.defer();
                        deferred.resolve(successResponse);
                        return deferred.promise;
                    },
                    responseError: function(errorResponse){
                        var deferred = $q.defer();

                        // Check if this request 
                        // - is a match
                        // - Failed because we unexpectedly went offline (status -1)
                        // - Was not previously queued
                        if( 
                            errorResponse.config &&
                            containsAny(matches, errorResponse.config.url) &&
                            errorResponse.status === -1 &&
                            !errorResponse.config.queuedRequest
                        ){
                            // Add a copy of this request to the Offline queue
                            var _config = angular.copy(errorResponse.config);
                            _config.queuedRequest = true;
                            console.log('connection severed. adding to queue');
                            Offline.addToQueue( _config );
                        }
                        
                        deferred.reject(errorResponse);
                        return deferred.promise;
                    }
                };
            }];
    });
}());