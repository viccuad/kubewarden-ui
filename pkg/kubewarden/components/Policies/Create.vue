<script>
import jsyaml from 'js-yaml';
import merge from 'lodash/merge';
import isEmpty from 'lodash/isEmpty';
import isEqual from 'lodash/isEqual';

import CreateEditView from '@shell/mixins/create-edit-view';
import { _CREATE } from '@shell/config/query-params';
import { saferDump } from '@shell/utils/create-yaml';
import { set } from '@shell/utils/object';

import { Banner } from '@components/Banner';

import AsyncButton from '@shell/components/AsyncButton';
import Loading from '@shell/components/Loading';
import ChartReadme from '@shell/components/ChartReadme';
import Wizard from '@shell/components/Wizard';

import { ARTIFACTHUB_PKG_ANNOTATION, NAMESPACE_SELECTOR } from '../../plugins/kubewarden-class';
import { DEFAULT_POLICY } from '../../plugins/policy-class';
import { KUBEWARDEN_PRODUCT_NAME, VALUES_STATE } from '../../types';
import { removeEmptyAttrs } from '../../utils/object';
import { handleGrowlError } from '../../utils/handle-growl';

import PolicyGrid from './PolicyGrid';
import Values from './Values';

export default ({
  name: 'Create',

  components: {
    AsyncButton,
    Banner,
    Loading,
    ChartReadme,
    Wizard,
    PolicyGrid,
    Values
  },

  props: {
    mode: {
      type:    String,
      default: _CREATE
    },

    value: {
      type:     Object,
      default:  () => ({})
    },
  },

  mixins: [CreateEditView],

  async fetch() {
    this.errors = [];

    if ( this.hasArtifactHub ) {
      await this.getPackages();
    }

    this.value.apiVersion = `${ this.schema?.attributes?.group }.${ this.schema?.attributes?.version }`;
    this.value.kind = this.schema?.attributes?.kind;
  },

  data() {
    return {
      errors:            [],
      bannerTitle:       null,
      loadingPackages:   false,
      packages:          null,
      repository:        null,
      type:              null,
      typeModule:        null,
      version:           null,

      chartValues: {
        policy:    {},
        questions: {}
      },
      yamlValues: '',

      hasCustomPolicy: false,
      yamlOption:      VALUES_STATE.FORM,

      // Steps
      stepPolicies: {
        hidden: false,
        name:   'policies',
        label:  'Policies',
        ready:  false,
        weight: 99
      },
      stepReadme: {
        hidden: false,
        name:   'readme',
        label:  'Readme',
        ready:  true,
        weight: 98
      },
      stepValues: {
        name:   'values',
        label:  'Values',
        ready:  true,
        weight: 97
      },
    };
  },

  computed: {
    isAirgap() {
      return this.$store.getters['kubewarden/airGapped'];
    },

    isCreate() {
      return this.realMode === _CREATE;
    },

    isSelected() {
      return !!this.type;
    },

    customPolicy() {
      return this.type === 'custom';
    },

    /** Allow create if either editing in yaml view or module and required rules/settings have been met */
    canFinish() {
      if ( this.yamlOption === VALUES_STATE.YAML ) {
        return true;
      }

      return !!this.chartValues?.policy?.spec?.module && this.hasRequired;
    },

    hasArtifactHub() {
      return this.value.artifactHubWhitelist;
    },

    /** Determines if the required rules/settings are set, if not the resource can not be created */
    hasRequired() {
      if ( !isEmpty(this.chartValues?.policy) ) {
        const { rules, settings } = this.chartValues?.policy?.spec;

        const requiredRules = ['apiVersions', 'operations', 'resources'];
        const acceptedRules = this.acceptedValues(rules, requiredRules);

        const requiredQuestions = this.chartValues?.questions?.questions?.map((q) => {
          if ( q.required ) {
            return q.variable;
          }
        }).filter(Boolean);
        const acceptedQuestions = this.acceptedValues(settings, requiredQuestions);

        if ( !isEmpty(acceptedRules) && (isEmpty(requiredQuestions) || !isEmpty(acceptedQuestions)) ) {
          return true;
        }
      }

      return false;
    },

    hideArtifactHubBanner() {
      return this.$store.getters['kubewarden/hideBannerArtifactHub'] || !!this.hasArtifactHub || !!this.isAirgap;
    },

    hideAirgapBanner() {
      return !this.isAirgap || this.$store.getters['kubewarden/hideBannerAirgapPolicy'];
    },

    packageValues() {
      if ( this.type?.name ) {
        const pkg = this.packages?.find(p => p.name === this.type.name);

        return pkg;
      }

      return null;
    },

    steps() {
      const steps = [];

      steps.push(
        this.stepPolicies,
        this.stepReadme,
        this.stepValues
      );

      return steps.sort((a, b) => b.weight - a.weight);
    }
  },

  methods: {
    /** Determine values which need to be required from supplied property and keys */
    acceptedValues(requiredProp, requiredKeys) {
      if ( isEmpty(requiredKeys) ) {
        return null;
      }

      let accepted;

      if ( Array.isArray(requiredProp) ) {
        accepted = requiredProp.find(prop => this.checkProperties(prop, requiredKeys));
      } else {
        accepted = this.checkProperties(requiredProp, requiredKeys);
      }

      return accepted;
    },

    /** Check supplied property for required keys */
    checkProperties(requiredProp, requiredKeys) {
      const match = [];

      for ( const key of requiredKeys?.values() ) {
        if ( !isEmpty(requiredProp[key]) ) {
          match.push(key);
        }
      }
      if ( requiredKeys && isEqual(match, requiredKeys) ) {
        return requiredProp;
      }

      return null;
    },

    async closeBanner(banner, retry = 0) {
      const res = await this.$store.dispatch(`kubewarden/${ banner }`, true);

      if ( retry === 0 && res?.type === 'error' && res?.status === 500 ) {
        await this.close(retry + 1);
      }
    },

    async addArtifactHub(btnCb) {
      try {
        this.loadingPackages = true;

        await this.value.updateWhitelist('artifacthub.io');
        await this.getPackages();

        btnCb(true);
        this.loadingPackages = false;
      } catch (e) {
        handleGrowlError({ error: e, store: this.$store });

        btnCb(false);
        this.loadingPackages = false;
      }
    },

    done() {
      this.$router.replace({
        name:   'c-cluster-product-resource',
        params: {
          cluster:  this.$route.params.cluster,
          product:  KUBEWARDEN_PRODUCT_NAME,
          resource: this.schema?.id
        }
      });
    },

    async finish(event) {
      try {
        let out;

        if ( this.yamlOption === VALUES_STATE.YAML ) {
          out = jsyaml.load(this.yamlValues);
        } else {
          out = this.chartValues?.policy ? this.chartValues.policy : jsyaml.load(this.yamlValues);
        }

        const { ignoreRancherNamespaces } = out;

        if ( ignoreRancherNamespaces ) {
          set(out.spec, 'namespaceSelector', { matchExpressions: [NAMESPACE_SELECTOR] });
          delete out.ignoreRancherNamespaces;
        }

        removeEmptyAttrs(out); // Clean up empty values from questions
        merge(this.value, out);

        await this.save(event);
      } catch (e) {
        handleGrowlError({ error: e, store: this.$store });

        console.error('Error creating policy', e); // eslint-disable-line no-console
      }
    },

    /** Fetch packages from ArtifactHub repository */
    async getPackages() {
      this.repository = await this.value.artifactHubRepo();

      if ( this.repository && this.repository.packages.length > 0 ) {
        const promises = this.repository.packages.map(pkg => this.packageDetails(pkg));

        try {
          const packages = await Promise.all(promises);

          this.packages = packages.filter(pkg => pkg?.data?.['kubewarden/hidden-ui'] !== 'true');
        } catch (e) {
          handleGrowlError({ error: e, store: this.$store });

          console.warn(`Error fetching packages`, e); // eslint-disable-line no-console
        }
      }
    },

    async packageDetails(pkg) {
      try {
        return await this.value.artifactHubPackage(pkg);
      } catch (e) {}
    },

    /** Extract policy questions from ArtifactHub package if available */
    policyQuestions() {
      const defaultPolicy = structuredClone(DEFAULT_POLICY);

      if ( this.type === 'custom' ) {
        // Add contextAwareResources to custom policy spec
        const updatedCustomPolicy = { spec: { contextAwareResources: [] } };

        merge(defaultPolicy, updatedCustomPolicy);
        set(this.chartValues, 'policy', defaultPolicy);
        this.yamlValues = saferDump(defaultPolicy);

        return;
      }

      const policyDetails = this.packages.find(pkg => pkg.name === this.type?.name);
      const packageQuestions = this.value.parsePackageMetadata(policyDetails?.data?.['kubewarden/questions-ui']);
      const packageAnnotation = `${ policyDetails.repository.name }/${ policyDetails.name }/${ policyDetails.version }`;
      /** Return spec from package if annotation exists */
      const parseAnnotation = (annotation, obj) => {
        const spec = this.value.parsePackageMetadata(policyDetails?.data?.[annotation]);

        if ( spec?.[obj] !== undefined ) {
          return spec[obj];
        }

        return spec || [];
      };

      /** Return value of annotation if it exists */
      const determineAnnotation = (annotation) => {
        if ( policyDetails?.data?.[annotation] !== undefined ) {
          return JSON.parse(policyDetails.data[annotation]);
        }

        return false;
      };

      const updatedPolicy = {
        apiVersion: this.value.apiVersion,
        kind:       this.value.kind,
        metadata:   { annotations: { [ARTIFACTHUB_PKG_ANNOTATION]: packageAnnotation } },
        spec:       {
          module:                policyDetails.containers_images[0].image,
          contextAwareResources: parseAnnotation('kubewarden/contextAwareResources', 'contextAwareResources'),
          rules:                 parseAnnotation('kubewarden/rules', 'rules'),
          mutating:              determineAnnotation('kubewarden/mutation')
        }
      };

      merge(defaultPolicy, updatedPolicy);
      set(this.chartValues, 'policy', defaultPolicy);

      this.yamlValues = saferDump(defaultPolicy);

      if ( packageQuestions ) {
        set(this.chartValues, 'questions', packageQuestions);
      }
    },

    reset(event) {
      this.$nextTick(() => {
        if ( event.step?.name === this.stepPolicies.name ) {
          const initialState = [
            'errors',
            'bannerTitle',
            'type',
            'typeModule',
            'version',
            'hasCustomPolicy',
          ];

          initialState.forEach((i) => {
            this[i] = null;
          });

          this.stepPolicies.ready = false;
          this.stepReadme.hidden = false;

          this.chartValues = {
            policy:    {},
            questions: {}
          };
          this.yamlOption = VALUES_STATE.FORM;
          this.yamlValues = '';
        }
      });
    },

    selectType(type) {
      this.type = type;
      const isCustom = type === 'custom';

      if ( isCustom ) {
        this.stepReadme.hidden = true;
        this.$set(this, 'hasCustomPolicy', true);
      } else {
        !!this.packageValues ? this.stepReadme.hidden = false : this.stepReadme.hidden = true;
        this.$set(this, 'hasCustomPolicy', false);
      }

      this.policyQuestions();
      this.stepPolicies.ready = true;
      this.$refs.wizard.next();
      this.bannerTitle = isCustom ? 'Custom Policy' : type?.display_name;
      this.typeModule = this.chartValues?.policy?.spec.module;
    }
  }

});
</script>

<template>
  <Loading v-if="$fetchState.pending" mode="relative" />
  <div v-else>
    <template v-if="!hideArtifactHubBanner">
      <Banner
        data-testid="kw-policy-create-ah-banner"
        class="type-banner mb-20 mt-0"
        color="warning"
        :closable="true"
        @close="closeBanner('updateHideBannerArtifactHub')"
      >
        <div>
          <p v-clean-html="t('kubewarden.policies.noArtifactHub', {}, true)" class="mb-10" />
          <AsyncButton mode="artifactHub" @click="addArtifactHub" />
        </div>
      </Banner>
    </template>
    <template v-if="!hideAirgapBanner">
      <Banner
        data-testid="kw-policy-create-ag-banner"
        class="type-banner mb-20 mt-0"
        color="warning"
        :closable="true"
        :label="t('kubewarden.policies.airgap.banner')"
        @close="closeBanner('updateHideBannerAirgapPolicy')"
      />
    </template>
    <Loading v-if="loadingPackages" />
    <Wizard
      v-if="value && !loadingPackages"
      ref="wizard"
      v-model="value"
      data-testid="kw-policy-create-wizard"
      :errors="errors"
      :steps="steps"
      :edit-first-step="true"
      :banner-title="bannerTitle"
      :banner-title-subtext="typeModule"
      class="wizard"
      @next="reset"
      @cancel="done"
      @finish="finish"
    >
      <template #policies>
        <PolicyGrid data-testid="kw-policy-create-grid" :value="packages" @selectType="selectType($event)">
          <template #customSubtype>
            <div data-testid="kw-grid-subtype-card-custom" class="subtype custom" @click="selectType('custom')">
              <div class="subtype__metadata">
                <div class="subtype__badge" :style="{ 'background-color': 'var(--darker)' }">
                  <label>{{ t('kubewarden.customPolicy.badge') }}</label>
                </div>

                <h4 class="subtype__label">
                  {{ t('kubewarden.customPolicy.title') }}
                </h4>

                <div class="subtype__description">
                  {{ t('kubewarden.customPolicy.description') }}
                </div>
              </div>
            </div>
          </template>
        </PolicyGrid>
      </template>

      <template #readme>
        <ChartReadme v-if="packageValues" data-testid="kw-policy-create-readme" :version-info="packageValues" class="mb-20" />
      </template>

      <template #values>
        <Values
          :value="value"
          :chart-values="chartValues"
          :yaml-values="yamlValues"
          :mode="mode"
          :custom-policy="customPolicy"
          @editor="$event => yamlOption = $event"
          @updateYamlValues="$event => yamlValues = $event"
        />
      </template>

      <template #finish>
        <AsyncButton
          data-testid="kw-policy-create-finish-button"
          :disabled="!canFinish"
          mode="finish"
          @click="finish"
        />
      </template>
    </Wizard>
  </div>
</template>

<style lang="scss" scoped>
$padding: 5px;
$height: 110px;
$margin: 10px;
$color: var(--body-text) !important;

::v-deep .step-container {
  height: auto;
}

::v-deep .header {
  .step-sequence {
    display: block;

    .steps {
      & .divider {
        top: 22px;
      }
    }
  }
}

::v-deep .controls-row {
  position: relative;
  width: auto;

  .controls-steps {
    display: flex;
  }
}

::v-deep .custom {
  min-height: 110px;
}

::v-deep .subtype {
  height: $height;
  margin: $margin;
  position: relative;
  border-radius: calc( 1.5 * var(--border-radius));
  border: 1px solid var(--border);
  text-decoration: none !important;
  color: $color;

  &:hover:not(.disabled) {
    box-shadow: 0 0 30px var(--shadow);
    transition: box-shadow 0.1s ease-in-out;
    cursor: pointer;
    text-decoration: none !important;
  }

  &__metadata {
    padding: $margin;

    &__label, &__description {
      padding-right: 20px;
    }
  }

  &__badge {
    position: absolute;
    right: 0;
    top: 0;
    padding: 4px $padding;
    border-bottom-left-radius: var(--border-radius);

    label {
      font-size: 12px;
      line-height: 12px;
      text-align: center;
      display: block;
      white-space: no-wrap;
      text-overflow: ellipsis;
      color: var(--app-rancher-accent-text);
      margin: 0;
    }
  }

  &__label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 4px;
    line-height: initial;
  }

  &__description {
    margin-right: $margin;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--input-label);
  }
}

.wizard {
  position: relative;
  height: 100%;
}
</style>
