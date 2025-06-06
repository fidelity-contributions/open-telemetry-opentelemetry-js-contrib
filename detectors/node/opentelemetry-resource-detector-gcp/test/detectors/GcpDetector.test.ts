/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  BASE_PATH,
  HEADER_NAME,
  HEADER_VALUE,
  HOST_ADDRESS,
  SECONDARY_HOST_ADDRESS,
  resetIsAvailableCache,
} from 'gcp-metadata';
import * as nock from 'nock';
import { gcpDetector } from '../../src';
import {
  assertCloudResource,
  assertHostResource,
  assertK8sResource,
  assertContainerResource,
  assertEmptyResource,
} from '@opentelemetry/contrib-test-utils';
import { detectResources } from '@opentelemetry/resources';

const HEADERS = {
  [HEADER_NAME.toLowerCase()]: HEADER_VALUE,
};
const INSTANCE_PATH = BASE_PATH + '/instance';
const INSTANCE_ID_PATH = BASE_PATH + '/instance/id';
const PROJECT_ID_PATH = BASE_PATH + '/project/project-id';
const ZONE_PATH = BASE_PATH + '/instance/zone';
const CLUSTER_NAME_PATH = BASE_PATH + '/instance/attributes/cluster-name';
const HOSTNAME_PATH = BASE_PATH + '/instance/hostname';

describe('gcpDetector', () => {
  describe('.detect', () => {
    before(() => {
      nock.disableNetConnect();
    });

    after(() => {
      nock.enableNetConnect();
      delete process.env.KUBERNETES_SERVICE_HOST;
      delete process.env.NAMESPACE;
      delete process.env.CONTAINER_NAME;
      delete process.env.HOSTNAME;
    });

    beforeEach(() => {
      resetIsAvailableCache();
      nock.cleanAll();
      delete process.env.KUBERNETES_SERVICE_HOST;
      delete process.env.NAMESPACE;
      delete process.env.CONTAINER_NAME;
      delete process.env.HOSTNAME;
    });

    it('should return resource with GCP metadata', async () => {
      const scope = nock(HOST_ADDRESS)
        .get(INSTANCE_PATH)
        .reply(200, {}, HEADERS)
        .get(INSTANCE_ID_PATH)
        // This number is too large to be safely represented by a JS number
        // See https://github.com/googleapis/gcp-metadata/tree/fc2f0778138b36285643b2f716c485bf9614611f#take-care-with-large-number-valued-properties
        .reply(200, () => '4520031799277581759', HEADERS)
        .get(PROJECT_ID_PATH)
        .reply(200, () => 'my-project-id', HEADERS)
        .get(ZONE_PATH)
        .reply(200, () => 'project/zone/my-zone', HEADERS)
        .get(HOSTNAME_PATH)
        .reply(200, () => 'dev.my-project.local', HEADERS);
      const secondaryScope = nock(SECONDARY_HOST_ADDRESS)
        .get(INSTANCE_PATH)
        .reply(200, {}, HEADERS);

      const resource = detectResources({ detectors: [gcpDetector] });
      await resource.waitForAsyncAttributes?.();

      secondaryScope.done();
      scope.done();

      assertCloudResource(resource, {
        provider: 'gcp',
        accountId: 'my-project-id',
        zone: 'my-zone',
      });
      assertHostResource(resource, {
        id: '4520031799277581759',
        name: 'dev.my-project.local',
      });
    });

    it('should populate K8s attributes when KUBERNETES_SERVICE_HOST is set', async () => {
      process.env.KUBERNETES_SERVICE_HOST = 'my-host';
      process.env.NAMESPACE = 'my-namespace';
      process.env.HOSTNAME = 'my-hostname';
      process.env.CONTAINER_NAME = 'my-container-name';
      const scope = nock(HOST_ADDRESS)
        .get(INSTANCE_PATH)
        .reply(200, {}, HEADERS)
        .get(INSTANCE_ID_PATH)
        .reply(200, () => '4520031799277581759', HEADERS)
        .get(CLUSTER_NAME_PATH)
        .reply(200, () => 'my-cluster', HEADERS)
        .get(PROJECT_ID_PATH)
        .reply(200, () => 'my-project-id', HEADERS)
        .get(ZONE_PATH)
        .reply(200, () => 'project/zone/my-zone', HEADERS)
        .get(HOSTNAME_PATH)
        .reply(200, () => 'dev.my-project.local', HEADERS);
      const secondaryScope = nock(SECONDARY_HOST_ADDRESS)
        .get(INSTANCE_PATH)
        .reply(200, {}, HEADERS);

      const resource = detectResources({ detectors: [gcpDetector] });
      await resource.waitForAsyncAttributes?.();

      secondaryScope.done();
      scope.done();

      assertCloudResource(resource, {
        provider: 'gcp',
        accountId: 'my-project-id',
        zone: 'my-zone',
      });
      assertK8sResource(resource, {
        clusterName: 'my-cluster',
        podName: 'my-hostname',
        namespaceName: 'my-namespace',
      });
      assertContainerResource(resource, { name: 'my-container-name' });
    });

    it('should return resource and empty data for non-available metadata attributes', async () => {
      // Set KUBERNETES_SERVICE_HOST to have the implementation call
      // CLUSTER_NAME_PATH, to be able to test it handling the HTTP 413.
      process.env.KUBERNETES_SERVICE_HOST = 'my-host';
      const scope = nock(HOST_ADDRESS)
        .get(INSTANCE_PATH)
        .reply(200, {}, HEADERS)
        .get(PROJECT_ID_PATH)
        .reply(200, () => 'my-project-id', HEADERS)
        .get(ZONE_PATH)
        .reply(413)
        .get(INSTANCE_ID_PATH)
        .reply(400, undefined, HEADERS)
        .get(CLUSTER_NAME_PATH)
        .reply(413)
        .get(HOSTNAME_PATH)
        .reply(400, undefined, HEADERS);
      const secondaryScope = nock(SECONDARY_HOST_ADDRESS)
        .get(INSTANCE_PATH)
        .reply(200, {}, HEADERS);

      const resource = detectResources({ detectors: [gcpDetector] });
      await resource.waitForAsyncAttributes?.();

      secondaryScope.done();
      scope.done();

      assertCloudResource(resource, {
        provider: 'gcp',
        accountId: 'my-project-id',
        zone: '',
      });
    });

    it('should return resource and undefined for non-available kubernetes attributes', async () => {
      process.env.KUBERNETES_SERVICE_HOST = 'my-host';
      process.env.HOSTNAME = 'my-hostname';
      process.env.CONTAINER_NAME = 'my-container-name';
      const scope = nock(HOST_ADDRESS)
        .get(INSTANCE_PATH)
        .reply(200, {}, HEADERS)
        .get(INSTANCE_ID_PATH)
        .reply(200, () => '4520031799277581759', HEADERS)
        .get(CLUSTER_NAME_PATH)
        .reply(200, () => 'my-cluster', HEADERS)
        .get(PROJECT_ID_PATH)
        .reply(200, () => 'my-project-id', HEADERS)
        .get(ZONE_PATH)
        .reply(200, () => 'project/zone/my-zone', HEADERS)
        .get(HOSTNAME_PATH)
        .reply(200, () => 'dev.my-project.local', HEADERS);
      const secondaryScope = nock(SECONDARY_HOST_ADDRESS)
        .get(INSTANCE_PATH)
        .reply(200, {}, HEADERS);

      const resource = detectResources({ detectors: [gcpDetector] });
      await resource.waitForAsyncAttributes?.();

      secondaryScope.done();
      scope.done();

      assertCloudResource(resource, {
        provider: 'gcp',
        accountId: 'my-project-id',
        zone: 'my-zone',
      });
      assertK8sResource(resource, {
        clusterName: 'my-cluster',
        podName: 'my-hostname',
        namespaceName: undefined,
      });
      assertContainerResource(resource, { name: 'my-container-name' });
    });

    it('returns empty resource if not detected', async () => {
      const resource = detectResources({ detectors: [gcpDetector] });
      await resource.waitForAsyncAttributes?.();
      assertEmptyResource(resource);
    });
  });
});
